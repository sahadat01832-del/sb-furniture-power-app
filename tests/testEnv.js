const crypto = require('crypto');
const os = require('os');
const path = require('path');

const suiteId = `sb-power-tests-${process.pid}`;
process.env.NODE_ENV = 'test';
// Tests serve on ephemeral ports; config only validates this value.
process.env.PORT = '3000';
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.ADMIN_PHONE = '01999887766';
process.env.ADMIN_PASSWORD = crypto.randomBytes(24).toString('hex');
process.env.DATABASE_FILE = path.join(os.tmpdir(), `${suiteId}.sqlite`);
process.env.BACKUP_DIR = path.join(os.tmpdir(), `${suiteId}-backups`);
process.env.FIREBASE_PROJECT_ID = '';
process.env.GOOGLE_APPLICATION_CREDENTIALS = '';
process.env.FIREBASE_BACKUP_ENCRYPTION_KEY = '';
process.env.FIREBASE_BACKUP_ENCRYPTION_KEY_FILE = '';
