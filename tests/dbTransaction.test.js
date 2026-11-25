require('./testEnv');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, run, query, withTransaction, closeDb } = require('../src/db');

before(async () => {
  await initDb();
  await run('CREATE TABLE IF NOT EXISTS tx_isolation_probe (id INTEGER PRIMARY KEY, label TEXT)');
  await run('CREATE TABLE IF NOT EXISTS tx_isolation_other (id INTEGER PRIMARY KEY, label TEXT)');
});

after(async () => {
  await closeDb();
});

test('DB 1: failed transaction rolls back only its own writes', async () => {
  await run('DELETE FROM tx_isolation_probe');
  await run('DELETE FROM tx_isolation_other');

  let markStarted;
  const transactionStarted = new Promise((resolve) => { markStarted = resolve; });

  const transaction = withTransaction(async ({ run: txRun }) => {
    await txRun("INSERT INTO tx_isolation_probe (label) VALUES ('inside-failed-transaction')");
    markStarted();
    await new Promise((resolve) => setTimeout(resolve, 80));
    throw new Error('simulated transaction failure');
  });

  await transactionStarted;

  // This comes from a different request. It must wait for the transaction and
  // survive its rollback instead of being silently rolled back with it.
  await run("INSERT INTO tx_isolation_other (label) VALUES ('unrelated-request-write')");

  await assert.rejects(transaction, /simulated transaction failure/);

  const probeRows = await query('SELECT * FROM tx_isolation_probe');
  const otherRows = await query('SELECT * FROM tx_isolation_other');

  assert.equal(probeRows.length, 0, 'the failed transaction insert must be rolled back');
  assert.equal(otherRows.length, 1, 'an unrelated write must survive the rollback');
  assert.equal(otherRows[0].label, 'unrelated-request-write');
});

test('DB 2: outside reads wait for an open transaction and never see uncommitted rows', async () => {
  await run('DELETE FROM tx_isolation_probe');

  let markStarted;
  const transactionStarted = new Promise((resolve) => { markStarted = resolve; });
  let transactionCallbackFinished = false;

  const transaction = withTransaction(async ({ run: txRun }) => {
    await txRun("INSERT INTO tx_isolation_probe (label) VALUES ('uncommitted')");
    markStarted();
    await new Promise((resolve) => setTimeout(resolve, 80));
    transactionCallbackFinished = true;
    return 'committed';
  });

  await transactionStarted;

  const rowsReadOutside = await query('SELECT * FROM tx_isolation_probe');

  assert.equal(
    transactionCallbackFinished,
    true,
    'outside read must wait until the transaction has finished'
  );
  assert.equal(rowsReadOutside.length, 1, 'read sees the committed row, never uncommitted data');
  assert.equal(await transaction, 'committed');

  await run('DELETE FROM tx_isolation_probe');
});
