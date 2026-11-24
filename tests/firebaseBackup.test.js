require('./testEnv');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  COLLECTION_NAME,
  createFirebaseBackupService,
  readEncryptionKey
} = require('../src/firebaseBackup');

function cloneRecord(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    Buffer.isBuffer(item) ? Buffer.from(item) : structuredClone(item)
  ]));
}

function createMemoryFirestore() {
  const collections = new Map();
  const getCollection = (collectionPath) => {
    if (!collections.has(collectionPath)) collections.set(collectionPath, new Map());
    return collections.get(collectionPath);
  };

  function makeDocument(collectionPath, id) {
    const reference = {
      id,
      async set(data) {
        getCollection(collectionPath).set(id, cloneRecord(data));
      },
      async get() {
        const records = getCollection(collectionPath);
        const data = records.get(id);
        return { id, ref: reference, exists: Boolean(data), data: () => (data ? cloneRecord(data) : undefined) };
      },
      async delete() {
        getCollection(collectionPath).delete(id);
      },
      collection(name) {
        return makeCollection(`${collectionPath}/${id}/${name}`);
      }
    };
    return reference;
  }

  function makeQuery(collectionPath, field = null, direction = 'asc', maxCount = null) {
    return {
      orderBy(nextField, nextDirection) {
        return makeQuery(collectionPath, nextField, nextDirection, maxCount);
      },
      limit(nextCount) {
        return makeQuery(collectionPath, field, direction, nextCount);
      },
      async get() {
        const records = [...getCollection(collectionPath).entries()];
        if (field) records.sort((left, right) => {
          const a = left[1][field];
          const b = right[1][field];
          const order = a < b ? -1 : a > b ? 1 : 0;
          return direction === 'desc' ? -order : order;
        });
        const selected = maxCount == null ? records : records.slice(0, maxCount);
        return {
          empty: selected.length === 0,
          docs: selected.map(([id, data]) => ({
            id,
            ref: makeDocument(collectionPath, id),
            data: () => cloneRecord(data)
          }))
        };
      }
    };
  }

  function makeCollection(collectionPath) {
    return {
      doc(id) {
        return makeDocument(collectionPath, id);
      },
      orderBy(field, direction) {
        return makeQuery(collectionPath, field, direction);
      },
      async get() {
        return makeQuery(collectionPath).get();
      }
    };
  }

  return {
    collection: makeCollection,
    batch() {
      const operations = [];
      return {
        set(reference, data) {
          operations.push(() => reference.set(data));
        },
        delete(reference) {
          operations.push(() => reference.delete());
        },
        async commit() {
          for (const operation of operations) await operation();
        }
      };
    },
    collectionSize(collectionPath) {
      return getCollection(collectionPath).size;
    }
  };
}

test('Firebase backup encrypts chunks, restores exact bytes, and retains recent snapshots', async () => {
  const firestore = createMemoryFirestore();
  const encryptionKey = crypto.randomBytes(32);
  const service = createFirebaseBackupService({ firestore, encryptionKey, retentionCount: 2 });
  const snapshots = [
    { filename: 'one.sqlite', snapshot: crypto.randomBytes(900 * 1024), createdAt: '2026-11-21T00:00:00.000Z' },
    { filename: 'two.sqlite', snapshot: crypto.randomBytes(900 * 1024), createdAt: '2026-11-22T00:00:00.000Z' },
    { filename: 'three.sqlite', snapshot: crypto.randomBytes(900 * 1024), createdAt: '2026-11-23T00:00:00.000Z' }
  ];

  const uploaded = [];
  for (const snapshot of snapshots) uploaded.push(await service.upload(snapshot));

  assert.equal(uploaded[2].success, true);
  assert.equal(uploaded[2].retainedSnapshots, 2);
  assert.equal(firestore.collectionSize(COLLECTION_NAME), 2);
  const restored = await service.downloadLatest();
  assert.equal(restored.backupId, uploaded[2].backupId);
  assert.deepEqual(restored.snapshot, snapshots[2].snapshot);
});

test('Firebase backup rejects bad keys, oversize snapshots, and tampered data', async () => {
  assert.throws(() => createFirebaseBackupService({ firestore: createMemoryFirestore(), encryptionKey: Buffer.alloc(31) }), /exactly 32 bytes/);

  const firestore = createMemoryFirestore();
  const encryptionKey = crypto.randomBytes(32);
  const service = createFirebaseBackupService({ firestore, encryptionKey, maxSnapshotBytes: 8 });
  await assert.rejects(
    service.upload({ filename: 'large.sqlite', snapshot: Buffer.alloc(9) }),
    (error) => error.code === 'backup_too_large'
  );

  const validService = createFirebaseBackupService({ firestore, encryptionKey });
  const uploaded = await validService.upload({
    filename: 'small.sqlite',
    snapshot: Buffer.from('private test snapshot'),
    createdAt: '2026-11-23T00:00:00.000Z'
  });
  const manifestRef = firestore.collection(COLLECTION_NAME).doc(uploaded.backupId);
  const manifest = (await manifestRef.get()).data();
  manifest.authTag = Buffer.alloc(16).toString('base64');
  await manifestRef.set(manifest);

  await assert.rejects(validService.downloadLatest(), /authenticate|integrity/i);
});

test('Firebase backup key loader accepts a 32-byte key and rejects malformed text', () => {
  const key = crypto.randomBytes(32);
  assert.deepEqual(readEncryptionKey({ keyValue: key.toString('base64') }), key);
  assert.throws(() => readEncryptionKey({ keyValue: 'not-a-secure-key' }), /exactly 32 bytes/);
});
