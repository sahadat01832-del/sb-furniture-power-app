const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const outputPath = path.resolve(process.argv[2] || path.join(projectRoot, 'dist-phone', 'sb-power-phone-server.tar.gz'));
const forbiddenEntry = /(^|\/)(\.env(?:\.local)?|\.aws|\.codex|\.agents|\.ssh|\.gnupg|\.config|\.npm|\.firebase|\.firebaserc|[^/]*\.sqlite(?:-[^/]*)?|backups?|[^/]*firebase-adminsdk[^/]*\.json|firebase-service-account[^/]*\.json|service-account[^/]*\.json|firebase-backup\.key|[^/]*\.(?:keystore|jks))(?:\/|$)/i;

if (fs.existsSync(outputPath)) {
  console.error(`Output already exists; it was not overwritten: ${outputPath}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
const excludes = [
  '.git',
  '.aws',
  '.codex',
  '.agents',
  '.ssh',
  '.gnupg',
  '.config',
  '.npm',
  '.firebase',
  '.firebaserc',
  'node_modules',
  '.env',
  '.env.local',
  'android',
  'android-admin',
  'config',
  'data',
  'logs',
  'dist-phone',
  'dist-apk/*.idsig',
  'dist-apk/*.unsigned*',
  '*.sqlite',
  '*.sqlite-*',
  '*.keystore',
  '*.jks',
  '*firebase-adminsdk*.json',
  'firebase-service-account*.json',
  'service-account*.json',
  'firebase-backup.key'
];
const args = ['-czf', outputPath];
for (const entry of excludes) args.push(`--exclude=${entry}`);
args.push('-C', projectRoot, '.');

const archiveResult = spawnSync('tar', args, { encoding: 'utf8' });
if (archiveResult.error || archiveResult.status !== 0) {
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  console.error(`Could not create phone package: ${archiveResult.error ? archiveResult.error.message : archiveResult.stderr.trim()}`);
  process.exit(1);
}

const listing = spawnSync('tar', ['-tzf', outputPath], { encoding: 'utf8' });
if (listing.error || listing.status !== 0 || listing.stdout.split('\n').some((entry) => forbiddenEntry.test(entry))) {
  fs.unlinkSync(outputPath);
  console.error('The package contained a private or database file and was removed.');
  process.exit(1);
}

const bytes = fs.statSync(outputPath).size;
console.log(`Phone server package created: ${outputPath} (${(bytes / 1024 / 1024).toFixed(2)} MiB).`);
console.log('The package excludes developer credentials, .env, SQLite databases, backup keys, service-account JSON, and signing keys.');
