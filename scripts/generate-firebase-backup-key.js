const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const destination = path.resolve(process.argv[2] || path.join(os.homedir(), '.config', 'sb-power', 'firebase-backup.key'));
fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(path.dirname(destination), 0o700);

let fileDescriptor;
try {
  fileDescriptor = fs.openSync(destination, 'wx', 0o600);
  fs.writeFileSync(fileDescriptor, `${crypto.randomBytes(32).toString('base64')}\n`);
  if (process.platform !== 'win32') fs.fchmodSync(fileDescriptor, 0o600);
  fs.fsyncSync(fileDescriptor);
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('A key file already exists there; it was not overwritten. Choose another path or keep using the existing key.');
  } else {
    console.error(`Could not create the key file: ${error.message}`);
  }
  process.exitCode = 1;
} finally {
  if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
}

if (process.exitCode !== 1) {
  console.log(`Created a 32-byte backup key at ${destination}. The secret itself was not printed.`);
  console.log('Keep a secure second copy outside this phone. Without that key, encrypted Firebase backups cannot be restored.');
}
