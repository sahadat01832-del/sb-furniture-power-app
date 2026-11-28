const config = require('./config');
const { performBackup } = require('./backup');
const { syncUploadsBackup, getUploadsBackupStatus } = require('./uploadsBackup');
const { getFirebaseBackupStatus } = require('./firebaseBackup');

// Runs the database snapshot and the off-phone product photo backup on one
// schedule. The dependencies are injectable so the tick itself can be exercised
// with a short interval instead of waiting six hours.
function startScheduledBackups({
  intervalMs = config.BACKUP_INTERVAL_MINUTES * 60 * 1000,
  databaseBackup = performBackup,
  uploadsBackup = syncUploadsBackup,
  databaseStatus = getFirebaseBackupStatus,
  uploadsStatus = getUploadsBackupStatus,
  logger = console
} = {}) {
  const cloudStatus = databaseStatus();
  if (!cloudStatus.configured) {
    logger.warn(`⚠️ Encrypted cloud backup is OFF. Missing: ${cloudStatus.missing.join(', ')}. Only local backups will be kept.`);
  }
  logger.log(`🗄️ Database backup schedule: every ${config.BACKUP_INTERVAL_MINUTES} minutes.`);

  const photoStatus = uploadsStatus();
  if (!photoStatus.configured) {
    logger.warn(`⚠️ Product photo backup is OFF. Missing: ${photoStatus.missing.join(', ')}.`);
  } else {
    logger.log('🖼️ Product photo backup: enabled on the same schedule.');
  }

  const runBackup = () => {
    databaseBackup().catch((error) => {
      logger.error('Scheduled database backup failed:', error.message);
    });
    // Product photos live only on this phone, so they are backed up off-device
    // on the same schedule; the sync uploads only files that changed.
    return uploadsBackup()
      .then((result) => {
        if (result && result.success && result.uploaded > 0) {
          logger.log(`🖼️ Product photo backup: ${result.uploaded} uploaded, ${result.removed} removed.`);
        } else if (result && result.success) {
          logger.log(`🖼️ Product photo backup: up to date (${result.unchanged} unchanged).`);
        } else if (result && !result.success) {
          logger.warn(`⚠️ Product photo backup failed (${result.errorCode}); photos are still on this phone.`);
        }
        return result;
      })
      .catch((error) => {
        logger.error('Scheduled product photo backup failed:', error.message);
      });
  };

  const timer = setInterval(runBackup, intervalMs);
  // Do not hold the process open just for the backup schedule.
  if (typeof timer.unref === 'function') timer.unref();

  runBackup();

  return {
    timer,
    runNow: runBackup,
    stop: () => clearInterval(timer)
  };
}

module.exports = { startScheduledBackups };
