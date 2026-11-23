const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const rootDir = path.join(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

const buildScript = path.join(__dirname, 'build-apks.sh');
const result = spawnSync('bash', [buildScript, ...process.argv.slice(2)], {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit'
});

if (result.error) {
  console.error('Could not start the Android APK build process.');
  process.exitCode = 1;
} else {
  process.exitCode = result.status === null ? 1 : result.status;
}
