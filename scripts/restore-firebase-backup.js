require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { downloadLatestFirebaseBackup } = require('../src/firebaseBackup');

function readOutputPath(args) {
  const outputIndex = args.indexOf('--output');
  if (outputIndex === -1 || !args[outputIndex + 1]) {
    throw new Error('Usage: npm run restore:firebase -- --output /absolute/new/path/database.sqlite');
  }
  return path.resolve(args[outputIndex + 1]);
}

async function main() {
  const outputPath = readOutputPath(process.argv.slice(2));
  const backup = await downloadLatestFirebaseBackup();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, backup.snapshot, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(outputPath, 0o600);
  console.log(`Restored encrypted Firebase snapshot to a new file: ${outputPath}`);
  console.log(`Backup time: ${backup.createdAt}; size: ${backup.snapshot.length} bytes.`);
  console.log('The existing application database was not overwritten. Review the restored file before changing DATABASE_FILE.');
}

main().catch((error) => {
  console.error(`Firebase backup restore failed: ${error.message}`);
  process.exitCode = 1;
});
