require('./testEnv');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { docIdFor, isBackupImage, planUploadSync } = require('../src/uploadsBackup');

test('Uploads backup 1: only product photos are backed up', () => {
  assert.equal(isBackupImage('products/SBP-101.jpg'), true);
  assert.equal(isBackupImage('bikroy/photo.webp'), true);
  assert.equal(isBackupImage('nested/deeper/pic.PNG'), true);
  assert.equal(isBackupImage('.gitkeep'), false);
  assert.equal(isBackupImage('products/.hidden.jpg'), false);
  assert.equal(isBackupImage('notes.txt'), false);
  assert.equal(isBackupImage(''), false);
});

test('Uploads backup 2: sync plan uploads new and changed files, keeps the rest', () => {
  const remote = [
    { id: 'a', relativePath: 'products/same.jpg', sha256: 'hash-same' },
    { id: 'b', relativePath: 'products/edited.jpg', sha256: 'hash-old' },
    { id: 'c', relativePath: 'products/deleted.jpg', sha256: 'hash-gone' }
  ];
  const local = [
    { relativePath: 'products/same.jpg', sha256: 'hash-same' },
    { relativePath: 'products/edited.jpg', sha256: 'hash-new' },
    { relativePath: 'products/added.jpg', sha256: 'hash-added' }
  ];

  const plan = planUploadSync(remote, local);
  assert.deepEqual(plan.uploads.map((file) => file.relativePath), ['products/edited.jpg', 'products/added.jpg']);
  assert.deepEqual(plan.unchanged, ['products/same.jpg']);
  assert.deepEqual(plan.removals.map((entry) => entry.relativePath), ['products/deleted.jpg']);
});

test('Uploads backup 3: an empty first run plans every file and a second run plans nothing', () => {
  const local = [
    { relativePath: 'products/a.jpg', sha256: 'hash-a' },
    { relativePath: 'products/b.png', sha256: 'hash-b' }
  ];

  const first = planUploadSync([], local);
  assert.equal(first.uploads.length, 2);
  assert.equal(first.removals.length, 0);

  const stored = local.map((file, index) => ({ id: String(index), ...file }));
  const second = planUploadSync(stored, local);
  assert.equal(second.uploads.length, 0);
  assert.equal(second.unchanged.length, 2);
  assert.equal(second.removals.length, 0);
});

test('Uploads backup 4: document ids are stable and slash-free', () => {
  const id = docIdFor('products/SBP-101.jpg');
  assert.equal(id, docIdFor('products/SBP-101.jpg'));
  assert.notEqual(id, docIdFor('products/SBP-102.jpg'));
  assert.doesNotMatch(id, /\//);
});
