const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Off-phone backup for the product photos in public/uploads.
//
// public/uploads is gitignored and lives only on the phone, while the SQLite
// snapshots cover the database alone. Losing the phone would therefore lose
// every product photo even though prices and orders survive.
//
// Firebase Cloud Storage is not enabled for this project, so the photos go into
// Firestore next to the database backups, using the same chunking idea: one
// manifest document per file plus 384 KiB chunk documents holding base64 data.
// Only files whose sha256 changed are re-uploaded, so the schedule stays cheap.

const COLLECTION_NAME = 'sb_power_upload_backups';
const CHUNK_COLLECTION_NAME = 'upload_chunks';
const CHUNK_BYTES = 384 * 1024;
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg']);
const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
};

let firebaseApp;
let firestoreClient;
let activeSync = null;
let lastState = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastUploadedCount: null,
  lastRemovedCount: null,
  lastErrorCode: null
};

function configurationStatus() {
  const missing = [];
  if (!(process.env.FIREBASE_PROJECT_ID || '').trim()) missing.push('FIREBASE_PROJECT_ID');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) missing.push('GOOGLE_APPLICATION_CREDENTIALS');
  return { configured: missing.length === 0, missing };
}

function getService() {
  const status = configurationStatus();
  if (!status.configured) {
    const error = new Error('Firebase upload backups are not configured.');
    error.code = 'uploads_backup_config_missing';
    throw error;
  }
  if (firestoreClient) return { firestore: firestoreClient };

  const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const appName = 'sb-power-uploads-backup';
  const app = getApps().find((item) => item.name === appName) || initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID.trim()
  }, appName);
  firebaseApp = app;
  firestoreClient = getFirestore(app);
  return { firestore: firestoreClient };
}

// Firestore document ids may not contain slashes, so the path is hashed.
function docIdFor(relativePath) {
  return crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 40);
}

function isBackupImage(relativePath) {
  if (!relativePath || relativePath.split('/').some((part) => part.startsWith('.'))) return false;
  return IMAGE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

async function listLocalUploads(rootDir = UPLOADS_DIR) {
  const files = [];

  async function walk(directory, prefix) {
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && isBackupImage(relativePath)) {
        const stats = await fs.promises.stat(path.join(directory, entry.name));
        files.push({ relativePath, sizeBytes: stats.size, modifiedMs: stats.mtimeMs });
      }
    }
  }

  await walk(rootDir, '');
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Compares the stored manifest with the files on disk.
 * `remoteEntries` are `{ id, relativePath, sha256 }` manifest documents;
 * `localFiles` are `{ relativePath, sha256 }`. hashing is done by the caller so
 * a file is read only once.
 */
function planUploadSync(remoteEntries, localFiles) {
  const remoteByPath = new Map();
  for (const entry of remoteEntries) {
    if (entry && entry.relativePath) remoteByPath.set(entry.relativePath, entry);
  }

  const uploads = [];
  const unchanged = [];
  const localPaths = new Set();

  for (const file of localFiles) {
    localPaths.add(file.relativePath);
    const remote = remoteByPath.get(file.relativePath);
    if (remote && remote.sha256 === file.sha256) unchanged.push(file.relativePath);
    else uploads.push(file);
  }

  const removals = remoteEntries.filter((entry) => entry.relativePath && !localPaths.has(entry.relativePath));
  return { uploads, unchanged, removals };
}

async function readLocalFile(relativePath, rootDir) {
  const buffer = await fs.promises.readFile(path.join(rootDir, relativePath));
  return { buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

// Firestore round trips dominate on a phone connection, so a few files are
// written at a time instead of one after another.
async function forEachLimited(items, limit, worker) {
  for (let index = 0; index < items.length; index += limit) {
    await Promise.all(items.slice(index, index + limit).map(worker));
  }
}

async function storeFile(firestore, file, buffer, sha256, { hadRemoteCopy = false } = {}) {
  const docRef = firestore.collection(COLLECTION_NAME).doc(docIdFor(file.relativePath));
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
    chunks.push(buffer.subarray(offset, offset + CHUNK_BYTES).toString('base64'));
  }

  await docRef.set({
    relativePath: file.relativePath,
    sizeBytes: buffer.length,
    sha256,
    chunkCount: chunks.length,
    mimeType: MIME_BY_EXTENSION[path.extname(file.relativePath).toLowerCase()] || 'application/octet-stream',
    updatedAt: new Date().toISOString()
  });

  const writes = chunks.map((data, index) => (
    docRef.collection(CHUNK_COLLECTION_NAME).doc(String(index)).set({ index, data })
  ));
  // Drop chunks left over from a previous, larger version of the same photo.
  if (hadRemoteCopy) {
    const existing = await docRef.collection(CHUNK_COLLECTION_NAME).get();
    const stale = existing.docs.filter((doc) => Number(doc.id) >= chunks.length);
    for (const doc of stale) await doc.ref.delete();
  }
  await Promise.all(writes);
}

async function deleteFile(firestore, entry) {
  const docRef = firestore.collection(COLLECTION_NAME).doc(entry.id);
  const chunks = await docRef.collection(CHUNK_COLLECTION_NAME).get();
  for (const chunk of chunks.docs) await chunk.ref.delete();
  await docRef.delete();
}

async function syncUploadsBackup({ rootDir = UPLOADS_DIR, dryRun = false } = {}) {
  if (activeSync) return activeSync;
  activeSync = runSync({ rootDir, dryRun }).finally(() => {
    activeSync = null;
  });
  return activeSync;
}

async function runSync({ rootDir, dryRun }) {
  lastState = { ...lastState, lastAttemptAt: new Date().toISOString(), lastErrorCode: null };
  try {
    const { firestore } = getService();
    const snapshot = await firestore.collection(COLLECTION_NAME).get();
    const remoteEntries = snapshot.docs.map((doc) => ({
      id: doc.id,
      relativePath: doc.data().relativePath,
      sha256: doc.data().sha256
    }));

    // Hash the files on disk, then compare against the stored manifest.
    const localFiles = [];
    for (const file of await listLocalUploads(rootDir)) {
      const { sha256 } = await readLocalFile(file.relativePath, rootDir);
      localFiles.push({ ...file, sha256 });
    }

    const plan = planUploadSync(remoteEntries, localFiles);
    if (!dryRun) {
      const storedPaths = new Set(remoteEntries.map((entry) => entry.relativePath));
      await forEachLimited(plan.uploads, 5, async (file) => {
        const { buffer, sha256 } = await readLocalFile(file.relativePath, rootDir);
        await storeFile(firestore, file, buffer, sha256, { hadRemoteCopy: storedPaths.has(file.relativePath) });
      });
      await forEachLimited(plan.removals, 5, (entry) => deleteFile(firestore, entry));
    }

    lastState = {
      ...lastState,
      lastSuccessAt: new Date().toISOString(),
      lastUploadedCount: plan.uploads.length,
      lastRemovedCount: plan.removals.length
    };
    return {
      configured: true,
      success: true,
      dryRun,
      uploaded: plan.uploads.length,
      unchanged: plan.unchanged.length,
      removed: plan.removals.length
    };
  } catch (error) {
    lastState = {
      ...lastState,
      lastFailureAt: new Date().toISOString(),
      lastErrorCode: error.code || 'firestore_unavailable'
    };
    return { configured: configurationStatus().configured, success: false, errorCode: lastState.lastErrorCode };
  }
}

/**
 * Downloads every stored photo into `targetDir`, verifying each sha256.
 * Existing files are kept unless `force` is set, so a restore cannot silently
 * overwrite newer photos on a working phone.
 */
async function restoreUploads({ targetDir = UPLOADS_DIR, force = false } = {}) {
  const { firestore } = getService();
  const snapshot = await firestore.collection(COLLECTION_NAME).get();
  const result = { written: 0, skipped: 0, failed: [] };

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const relativePath = String(data.relativePath || '');
    if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) {
      result.failed.push({ relativePath, reason: 'unsafe_path' });
      continue;
    }
    const destination = path.join(targetDir, relativePath);
    if (!force && fs.existsSync(destination)) {
      result.skipped += 1;
      continue;
    }

    const chunks = await doc.ref.collection(CHUNK_COLLECTION_NAME).orderBy('index').get();
    const buffer = Buffer.concat(chunks.docs.map((chunk) => Buffer.from(chunk.data().data || '', 'base64')));
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (sha256 !== data.sha256) {
      result.failed.push({ relativePath, reason: 'checksum_mismatch' });
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, buffer);
    result.written += 1;
  }

  return result;
}

function getUploadsBackupStatus() {
  return { ...configurationStatus(), ...lastState };
}

async function closeUploadsBackup() {
  if (firestoreClient && typeof firestoreClient.terminate === 'function') {
    await firestoreClient.terminate();
  }
  if (firebaseApp) {
    const { deleteApp } = require('firebase-admin/app');
    await deleteApp(firebaseApp);
  }
  firestoreClient = null;
  firebaseApp = null;
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  syncUploadsBackup()
    .then((result) => {
      console.log('Uploads backup:', JSON.stringify(result));
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Uploads backup failed:', error.message);
      process.exit(1);
    });
}

module.exports = {
  COLLECTION_NAME,
  CHUNK_COLLECTION_NAME,
  CHUNK_BYTES,
  UPLOADS_DIR,
  docIdFor,
  isBackupImage,
  listLocalUploads,
  planUploadSync,
  syncUploadsBackup,
  restoreUploads,
  getUploadsBackupStatus,
  closeUploadsBackup
};
