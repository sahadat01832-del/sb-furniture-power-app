require('./testEnv');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startScheduledBackups } = require('../src/scheduledBackups');

function quietLogger() {
  const lines = [];
  return {
    lines,
    log: (...args) => lines.push(args.join(' ')),
    warn: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' '))
  };
}

const enabledStatus = { configured: true, missing: [] };

test('Scheduler 1: a tick runs the database backup and the photo backup', async () => {
  const calls = { database: 0, uploads: 0 };
  const logger = quietLogger();
  const scheduler = startScheduledBackups({
    intervalMs: 60_000,
    databaseStatus: () => enabledStatus,
    uploadsStatus: () => enabledStatus,
    databaseBackup: async () => { calls.database += 1; return {}; },
    uploadsBackup: async () => { calls.uploads += 1; return { success: true, uploaded: 0, unchanged: 191, removed: 0 }; },
    logger
  });

  await scheduler.runNow();
  scheduler.stop();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(calls.database, 2, 'initial tick plus the explicit one');
  assert.equal(calls.uploads, 2);
  assert.ok(
    logger.lines.some((line) => line.includes('Product photo backup: up to date (191 unchanged)')),
    'the tick reports the photo sync result'
  );
});

test('Scheduler 2: the interval keeps firing until stopped', async () => {
  let uploads = 0;
  const scheduler = startScheduledBackups({
    intervalMs: 25,
    databaseStatus: () => enabledStatus,
    uploadsStatus: () => enabledStatus,
    databaseBackup: async () => ({}),
    uploadsBackup: async () => {
      uploads += 1;
      return { success: true, uploaded: 0, unchanged: 1, removed: 0 };
    },
    logger: quietLogger()
  });

  await new Promise((resolve) => setTimeout(resolve, 120));
  scheduler.stop();
  const seen = uploads;
  assert.ok(seen >= 3, `expected repeated ticks, saw ${seen}`);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(uploads, seen, 'no ticks after stop()');
});

test('Scheduler 3: a failing database backup does not skip the photo backup', async () => {
  let uploads = 0;
  const logger = quietLogger();
  const scheduler = startScheduledBackups({
    intervalMs: 60_000,
    databaseStatus: () => enabledStatus,
    uploadsStatus: () => enabledStatus,
    databaseBackup: async () => { throw new Error('disk full'); },
    uploadsBackup: async () => {
      uploads += 1;
      return { success: true, uploaded: 0, unchanged: 191, removed: 0 };
    },
    logger
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  scheduler.stop();

  assert.ok(uploads >= 1, 'photo backup still ran');
  assert.ok(logger.lines.some((line) => line.includes('Scheduled database backup failed')), 'the failure is logged');
});

test('Scheduler 4: a throw inside the photo backup is reported, not fatal', async () => {
  const logger = quietLogger();
  const scheduler = startScheduledBackups({
    intervalMs: 60_000,
    databaseStatus: () => enabledStatus,
    uploadsStatus: () => enabledStatus,
    databaseBackup: async () => ({}),
    uploadsBackup: async () => { throw new Error('firestore down'); },
    logger
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  scheduler.stop();
  assert.ok(logger.lines.some((line) => line.includes('Scheduled product photo backup failed')), 'the throw is logged');
});
