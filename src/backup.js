const fs = require('fs');
const path = require('path');
const config = require('./config');
const { db } = require('./db');

const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');
const MAX_BACKUPS_TO_KEEP = 30;

/**
 * Creates an atomic SQLite snapshot using VACUUM INTO.
 * Safe to run while the server is accepting live traffic.
 */
function performBackup() {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
      }

      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const backupFilename = `sb-database-backup-${dateStr}.sqlite`;
      const targetFilePath = path.join(BACKUP_DIR, backupFilename);

      if (fs.existsSync(targetFilePath)) {
        fs.unlinkSync(targetFilePath);
      }

      // SQLite 3.27+ native atomic defragmented snapshot
      db.run('VACUUM INTO ?', [targetFilePath], (err) => {
        if (err) {
          console.error('❌ Database Backup Failed:', err);
          return reject(err);
        }

        const stats = fs.statSync(targetFilePath);
        console.log(`✅ Database Backup Created Successfully:`);
        console.log(`   📁 File: ${targetFilePath}`);
        console.log(`   📦 Size: ${(stats.size / 1024).toFixed(2)} KB`);

        // Clean up old backups exceeding retention limit
        try {
          cleanOldBackups();
        } catch (cleanupErr) {
          console.warn('⚠️ Warning cleaning old backups:', cleanupErr.message);
        }

        resolve({
          success: true,
          filename: backupFilename,
          path: targetFilePath,
          sizeBytes: stats.size,
          createdAt: now.toISOString()
        });
      });
    } catch (error) {
      console.error('❌ Backup Exception:', error);
      reject(error);
    }
  });
}

/**
 * Deletes older backups keeping only the most recent N files.
 */
function cleanOldBackups(maxKeep = MAX_BACKUPS_TO_KEEP) {
  if (!fs.existsSync(BACKUP_DIR)) return;

  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => {
      const fullPath = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(fullPath);
      return { file: f, path: fullPath, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // Newest first

  if (files.length > maxKeep) {
    const toDelete = files.slice(maxKeep);
    for (const item of toDelete) {
      try {
        fs.unlinkSync(item.path);
        console.log(`🗑️ Removed old backup: ${item.file}`);
      } catch (e) {
        // Ignore deletion errors for locked files
      }
    }
  }
}

/**
 * Lists all existing database backups.
 */
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => {
      const fullPath = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(fullPath);
      const dateMs = stat.mtimeMs || (stat.mtime ? stat.mtime.getTime() : Date.now());
      return {
        filename: f,
        path: fullPath,
        sizeBytes: stat.size,
        sizeFormatted: `${(stat.size / 1024).toFixed(2)} KB`,
        createdAt: new Date(dateMs).toISOString(),
        mtimeMs: dateMs
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Standalone CLI execution
if (require.main === module) {
  performBackup()
    .then((res) => {
      console.log('🎉 Backup complete!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to create backup:', err);
      process.exit(1);
    });
}

module.exports = {
  performBackup,
  listBackups,
  cleanOldBackups,
  BACKUP_DIR
};
