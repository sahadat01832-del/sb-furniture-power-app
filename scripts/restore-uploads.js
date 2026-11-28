// Restores product photos from the off-phone Firestore backup.
//
// Usage:
//   npm run restore:uploads -- --output public/uploads
//   npm run restore:uploads -- --output /tmp/check --force
//
// Without --force an existing file is never overwritten, so running this on a
// working phone cannot replace newer photos with older ones.

require('dotenv').config({ quiet: true });

const path = require('path');
const { restoreUploads } = require('../src/uploadsBackup');

function readArgument(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} needs a directory path.`);
  return path.resolve(value);
}

async function main() {
  const args = process.argv.slice(2);
  const targetDir = readArgument(args, '--output', path.join(__dirname, '..', 'public', 'uploads'));
  const force = args.includes('--force');
  const result = await restoreUploads({ targetDir, force });

  console.log(`Restored ${result.written} photo(s) into ${targetDir}.`);
  if (result.skipped > 0) console.log(`Skipped ${result.skipped} existing file(s); pass --force to overwrite them.`);
  for (const failure of result.failed) {
    console.error(`Could not restore ${failure.relativePath}: ${failure.reason}`);
  }
  if (result.failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Uploads restore failed: ${error.message}`);
  process.exitCode = 1;
});
