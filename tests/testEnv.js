const crypto = require('crypto');
const os = require('os');
const path = require('path');

const suiteId = `sb-power-tests-${process.pid}`;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.ADMIN_PHONE = '01999887766';
process.env.ADMIN_PASSWORD = crypto.randomBytes(24).toString('hex');
process.env.DATABASE_FILE = path.join(os.tmpdir(), `${suiteId}.sqlite`);
process.env.BACKUP_DIR = path.join(os.tmpdir(), `${suiteId}-backups`);
