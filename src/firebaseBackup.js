const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const COLLECTION_NAME = 'sb_power_app_backups';
const CHUNK_COLLECTION_NAME = 'backup_chunks';
const CHUNK_BYTES = 384 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const DEFAULT_RETENTION = 7;
const LAST_FAILURE_CODES = new Set([
  'backup_config_missing',
  'backup_key_invalid',
  'backup_too_large',
  'firestore_unavailable',
  'backup_corrupt'
]);

let firebaseService;
let firebaseFirestoreClient;
let firebaseAdminApp;
let lastBackupState = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastBackupId: null,
  lastBackupSizeBytes: null,
  lastErrorCode: null
};

function readEncryptionKey({ keyFile, keyValue } = {}) {
  let contents = keyValue;
  if (keyFile) {
    const stat = fs.lstatSync(keyFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Encryption key path must be a regular file.');
    }
    contents = fs.readFileSync(keyFile);
  }
  if (contents == null || contents.length === 0) {
    throw new Error('Firebase backup encryption key is not configured.');
  }

  if (Buffer.isBuffer(contents) && contents.length === 32) return Buffer.from(contents);
  const text = Buffer.isBuffer(contents) ? contents.toString('utf8').trim() : String(contents).trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(text)) {
    key = Buffer.from(text, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=$/.test(text)) {
    key = Buffer.from(text, 'base64');
  }
  if (!key || key.length !== 32) {
    throw new Error('Firebase backup encryption key must decode to exactly 32 bytes.');
  }
  return key;
}

function encryptSnapshot(snapshot, encryptionKey) {
  if (!Buffer.isBuffer(snapshot)) throw new TypeError('Backup snapshot must be a Buffer.');
  if (snapshot.length > MAX_SNAPSHOT_BYTES) {
    const error = new Error('Database snapshot exceeds the Firebase backup size limit.');
    error.code = 'backup_too_large';
    throw error;
  }

  const compressed = zlib.gzipSync(snapshot, { level: 6 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext,
    sha256: crypto.createHash('sha256').update(snapshot).digest('hex'),
    rawBytes: snapshot.length,
    compressedBytes: compressed.length
  };
}

function decryptSnapshot(manifest, ciphertext, encryptionKey) {
  if (!manifest || manifest.formatVersion !== 1 || manifest.encryption !== 'aes-256-gcm' || manifest.compression !== 'gzip') {
    throw new Error('Unsupported Firebase backup format.');
  }
  if (!Number.isSafeInteger(manifest.rawBytes) || manifest.rawBytes < 0 || manifest.rawBytes > MAX_SNAPSHOT_BYTES) {
    throw new Error('Firebase backup size metadata is invalid.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(manifest.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(manifest.authTag, 'base64'));
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const snapshot = zlib.gunzipSync(compressed, { maxOutputLength: MAX_SNAPSHOT_BYTES });
  const sha256 = crypto.createHash('sha256').update(snapshot).digest('hex');
  if (snapshot.length !== manifest.rawBytes || sha256 !== manifest.sha256) {
    throw new Error('Firebase backup integrity check failed.');
  }
  return snapshot;
}

function splitBuffer(buffer, chunkBytes = CHUNK_BYTES) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length)));
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));
  return chunks;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value.toBuffer === 'function') return value.toBuffer();
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error('Firebase backup chunk is missing or invalid.');
}

function createFirebaseBackupService({ firestore, encryptionKey, retentionCount = DEFAULT_RETENTION, maxSnapshotBytes = MAX_SNAPSHOT_BYTES }) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new TypeError('A Firestore client is required.');
  }
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
    throw new Error('Firebase backup encryption key must be exactly 32 bytes.');
  }
  if (!Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 14) {
    throw new Error('Firebase backup retention must be between 1 and 14 snapshots.');
  }
  const collection = firestore.collection(COLLECTION_NAME);

  async function removeBackup(manifestRef) {
    const chunksSnapshot = await manifestRef.collection(CHUNK_COLLECTION_NAME).get();
    for (let index = 0; index < chunksSnapshot.docs.length; index += 400) {
      const batch = firestore.batch();
      for (const chunk of chunksSnapshot.docs.slice(index, index + 400)) batch.delete(chunk.ref);
      await batch.commit();
    }
    await manifestRef.delete();
  }

  async function trimRetention() {
    const snapshots = await collection.orderBy('createdAt', 'desc').get();
    for (const oldSnapshot of snapshots.docs.slice(retentionCount)) {
      await removeBackup(oldSnapshot.ref);
    }
    return Math.min(retentionCount, snapshots.docs.length);
  }

  async function upload({ filename, snapshot, createdAt = new Date().toISOString() }) {
    if (!Buffer.isBuffer(snapshot)) throw new TypeError('Backup snapshot must be a Buffer.');
    if (snapshot.length > maxSnapshotBytes) {
      const error = new Error('Database snapshot exceeds the configured Firebase backup size limit.');
      error.code = 'backup_too_large';
      throw error;
    }

    const encrypted = encryptSnapshot(snapshot, encryptionKey);
    const chunks = splitBuffer(encrypted.ciphertext);
    const backupId = `${Date.now()}-${crypto.randomUUID()}`;
    const manifestRef = collection.doc(backupId);
    const chunkCollection = manifestRef.collection(CHUNK_COLLECTION_NAME);
    const writtenChunkRefs = [];

    try {
      for (let index = 0; index < chunks.length; index += 16) {
        const batch = firestore.batch();
        for (const [offset, payload] of chunks.slice(index, index + 16).entries()) {
          const chunkIndex = index + offset;
          const chunkRef = chunkCollection.doc(String(chunkIndex).padStart(8, '0'));
          batch.set(chunkRef, { index: chunkIndex, payload });
          writtenChunkRefs.push(chunkRef);
        }
        await batch.commit();
      }

      const manifest = {
        formatVersion: 1,
        backupId,
        createdAt,
        sourceFilename: String(filename || '').slice(0, 100),
        encryption: 'aes-256-gcm',
        compression: 'gzip',
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        sha256: encrypted.sha256,
        rawBytes: encrypted.rawBytes,
        compressedBytes: encrypted.compressedBytes,
        encryptedBytes: encrypted.ciphertext.length,
        chunkCount: chunks.length
      };
      await manifestRef.set(manifest);

      let cleanupWarning = false;
      let retainedSnapshots = retentionCount;
      try {
        retainedSnapshots = await trimRetention();
      } catch (error) {
        cleanupWarning = true;
      }

      return {
        success: true,
        backupId,
        createdAt,
        sizeBytes: snapshot.length,
        cloudBytes: encrypted.ciphertext.length,
        retainedSnapshots,
        cleanupWarning
      };
    } catch (error) {
      const cleanup = firestore.batch();
      for (const ref of writtenChunkRefs) cleanup.delete(ref);
      if (writtenChunkRefs.length > 0) {
        try {
          await cleanup.commit();
        } catch (cleanupError) {
          // The incomplete snapshot has no published manifest and is ignored by restore.
        }
      }
      try {
        await manifestRef.delete();
      } catch (cleanupError) {
        // A failed manifest deletion is harmless to restores if its chunks were removed.
      }
      throw error;
    }
  }

  async function downloadLatest() {
    const manifests = await collection.orderBy('createdAt', 'desc').limit(1).get();
    if (manifests.empty || manifests.docs.length === 0) {
      throw new Error('No Firebase database backup was found.');
    }
    const manifestDocument = manifests.docs[0];
    const manifest = manifestDocument.data();
    if (!Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 1 || manifest.chunkCount > 100) {
      throw new Error('Firebase backup chunk metadata is invalid.');
    }

    const chunkSnapshot = await manifestDocument.ref.collection(CHUNK_COLLECTION_NAME).orderBy('index', 'asc').get();
    if (chunkSnapshot.docs.length !== manifest.chunkCount) {
      throw new Error('Firebase backup is incomplete.');
    }
    const buffers = [];
    for (let index = 0; index < chunkSnapshot.docs.length; index += 1) {
      const chunk = chunkSnapshot.docs[index].data();
      if (chunk.index !== index) throw new Error('Firebase backup chunk order is invalid.');
      buffers.push(asBuffer(chunk.payload));
    }
    const snapshot = decryptSnapshot(manifest, Buffer.concat(buffers), encryptionKey);
    return {
      snapshot,
      backupId: manifest.backupId,
      createdAt: manifest.createdAt,
      sha256: manifest.sha256
    };
  }

  return { upload, downloadLatest };
}

function configurationStatus() {
  const missing = [];
  if (!(process.env.FIREBASE_PROJECT_ID || '').trim()) missing.push('FIREBASE_PROJECT_ID');
  const credentialsPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!credentialsPath || !fs.existsSync(credentialsPath)) missing.push('GOOGLE_APPLICATION_CREDENTIALS');
  const keyFile = (process.env.FIREBASE_BACKUP_ENCRYPTION_KEY_FILE || '').trim();
  const keyValue = process.env.FIREBASE_BACKUP_ENCRYPTION_KEY;
  if (!keyFile && !keyValue) missing.push('FIREBASE_BACKUP_ENCRYPTION_KEY_FILE');
  return { configured: missing.length === 0, missing };
}

function getService() {
  const config = configurationStatus();
  if (!config.configured) {
    const error = new Error('Firebase encrypted backups are not configured.');
    error.code = 'backup_config_missing';
    throw error;
  }
  if (firebaseService) return firebaseService;

  let key;
  try {
    key = readEncryptionKey({
      keyFile: process.env.FIREBASE_BACKUP_ENCRYPTION_KEY_FILE,
      keyValue: process.env.FIREBASE_BACKUP_ENCRYPTION_KEY
    });
  } catch (error) {
    error.code = 'backup_key_invalid';
    throw error;
  }
  const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const appName = 'sb-power-encrypted-backups';
  const app = getApps().find((item) => item.name === appName) || initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID.trim()
  }, appName);
  const firestore = getFirestore(app);
  firebaseAdminApp = app;
  firebaseFirestoreClient = firestore;
  const retention = Number(process.env.FIREBASE_BACKUP_RETENTION || DEFAULT_RETENTION);
  firebaseService = createFirebaseBackupService({ firestore, encryptionKey: key, retentionCount: retention });
  return firebaseService;
}

function getFirebaseBackupStatus() {
  const config = configurationStatus();
  return {
    configured: config.configured,
    missing: config.missing,
    retentionCount: Number(process.env.FIREBASE_BACKUP_RETENTION || DEFAULT_RETENTION),
    ...lastBackupState
  };
}

async function uploadFirebaseBackup(backup) {
  lastBackupState = { ...lastBackupState, lastAttemptAt: new Date().toISOString(), lastErrorCode: null };
  try {
    const service = getService();
    const result = await service.upload({
      filename: backup.filename,
      snapshot: fs.readFileSync(backup.path),
      createdAt: backup.createdAt
    });
    lastBackupState = {
      ...lastBackupState,
      lastSuccessAt: result.createdAt,
      lastBackupId: result.backupId,
      lastBackupSizeBytes: result.sizeBytes,
      lastErrorCode: result.cleanupWarning ? 'retention_cleanup_failed' : null
    };
    return { configured: true, ...result };
  } catch (error) {
    const errorCode = LAST_FAILURE_CODES.has(error.code) ? error.code : 'firestore_unavailable';
    lastBackupState = {
      ...lastBackupState,
      lastFailureAt: new Date().toISOString(),
      lastErrorCode: errorCode
    };
    return {
      configured: configurationStatus().configured,
      success: false,
      errorCode
    };
  }
}

async function downloadLatestFirebaseBackup() {
  return getService().downloadLatest();
}

async function closeFirebaseBackup() {
  if (firebaseFirestoreClient && typeof firebaseFirestoreClient.terminate === 'function') {
    await firebaseFirestoreClient.terminate();
  }
  if (firebaseAdminApp) {
    const { deleteApp } = require('firebase-admin/app');
    await deleteApp(firebaseAdminApp);
  }
  firebaseFirestoreClient = null;
  firebaseAdminApp = null;
  firebaseService = null;
}

module.exports = {
  COLLECTION_NAME,
  CHUNK_COLLECTION_NAME,
  CHUNK_BYTES,
  MAX_SNAPSHOT_BYTES,
  createFirebaseBackupService,
  readEncryptionKey,
  encryptSnapshot,
  decryptSnapshot,
  uploadFirebaseBackup,
  downloadLatestFirebaseBackup,
  getFirebaseBackupStatus,
  closeFirebaseBackup
};
