#!/usr/bin/env node
// ============================================================
// Deploy the repository to the phone that hosts the live server.
//
//   npm run phone:status              -> report drift only (read-only)
//   npm run phone:deploy              -> upload changed files, restart pm2
//   npm run phone:deploy -- --no-restart
//   npm run phone:deploy -- --dry-run -> same check as status, no writes
//
// Only files tracked by git are considered, minus targets that do not belong
// on the phone (APK output, the Cloudflare Worker, CI config). Everything the
// phone owns locally — .env, node_modules, data/, logs/, public/uploads — is
// never touched, so a deploy cannot overwrite the live database or photos.
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID_SDK_DIRS = [
  '/home/don/whynet ecosystem/NEWTUBE/NewTube_Android/.android-sdk/platform-tools',
  process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools') : null,
  process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools') : null
].filter(Boolean);

const DEFAULT_DEVICE = '192.168.0.103:5555';
const DEFAULT_APP_DIR = '/data/data/com.termux/files/home/sb-power-app';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const PM2_CLI = '/data/data/com.termux/files/usr/lib/node_modules/pm2/bin/pm2';
const PM2_HOME = '/data/data/com.termux/files/home/.pm2';
const PM2_APP = 'sb-power-app';

// Paths that must never be pushed: they are either built on the machine or
// owned by the phone itself.
const EXCLUDED_PREFIXES = [
  'dist-apk/',
  'worker/',
  '.github/',
  'node_modules/',
  'public/uploads/',
  'data/',
  'logs/',
  'android/',
  'android-client/'
];

function findAdb() {
  if (process.env.ADB) return process.env.ADB;
  for (const dir of ANDROID_SDK_DIRS) {
    const candidate = path.join(dir, 'adb');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'adb';
}

const ADB = findAdb();
const DEVICE = process.env.PHONE_ADB_DEVICE || DEFAULT_DEVICE;
const APP_DIR = process.env.PHONE_APP_DIR || DEFAULT_APP_DIR;

function adb(args, options = {}) {
  return execFileSync(ADB, ['-s', DEVICE, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
}

// Runs a POSIX command as the Termux app, which owns the server files.
function phoneSh(command, options = {}) {
  const quoted = `'${command.replace(/'/g, `'\\''`)}'`;
  return adb(['shell', `run-as com.termux ${TERMUX_BIN}/sh -c ${quoted}`], options);
}

function ensureDevice() {
  const devices = adb(['devices']).split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  if (devices.some((line) => line.startsWith(`${DEVICE}\tdevice`))) return;
  if (devices.some((line) => line.startsWith(DEVICE))) {
    throw new Error(`${DEVICE} is connected but not ready (check "adb devices").`);
  }
  process.stdout.write(`Connecting to ${DEVICE}... `);
  try {
    adb(['connect', DEVICE]);
  } catch {
    // adb connect prints failure on stdout with exit code 0 on some versions.
  }
  const after = adb(['devices']);
  if (after.includes(`${DEVICE}\tdevice`)) {
    console.log('connected.');
    return;
  }
  throw new Error(`Cannot reach ${DEVICE}. Enable wireless debugging on the phone or set PHONE_ADB_DEVICE.`);
}

function trackedFiles() {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  return listed.filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Hashes every file on the phone in a few batched shell calls.
function remoteHashes(relativePaths) {
  const hashes = new Map();
  const batchSize = 120;
  for (let index = 0; index < relativePaths.length; index += batchSize) {
    const batch = relativePaths.slice(index, index + batchSize);
    const command = `cd ${quote(APP_DIR)} && sha256sum ${batch.map(quote).join(' ')} 2>/dev/null`;
    let output = '';
    try {
      output = phoneSh(command);
    } catch (error) {
      output = String(error.stdout || '');
    }
    for (const line of output.split('\n')) {
      const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
      if (match) hashes.set(match[2].trim(), match[1]);
    }
  }
  return hashes;
}

// Files the phone has under a synced directory that the repository does not.
function remoteOnlyFiles(syncedDirs, localPaths) {
  const extra = [];
  for (const dir of syncedDirs) {
    let output = '';
    try {
      output = phoneSh(`cd ${quote(APP_DIR)} && find ${quote(dir)} -type f 2>/dev/null`);
    } catch {
      continue;
    }
    for (const line of output.split('\n')) {
      const relative = line.trim().replace(/^\.\//, '');
      if (!relative || localPaths.has(relative)) continue;
      // Phone-owned paths (photos, database, logs) are never drift.
      if (EXCLUDED_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue;
      extra.push(relative);
    }
  }
  return extra;
}

function compare() {
  const localFiles = trackedFiles();
  const local = new Map();
  for (const file of localFiles) {
    const absolute = path.join(ROOT, file);
    local.set(file, sha256(fs.readFileSync(absolute)));
  }

  const remote = remoteHashes(localFiles);
  const missing = [];
  const changed = [];
  const identical = [];

  for (const [file, hash] of local) {
    const remoteHash = remote.get(file);
    if (!remoteHash) missing.push(file);
    else if (remoteHash !== hash) changed.push(file);
    else identical.push(file);
  }

  // Top-level directories that hold tracked files, so phone-only leftovers in
  // those directories are reported instead of silently ignored.
  const syncedDirs = [...new Set(localFiles.filter((file) => file.includes('/')).map((file) => file.split('/')[0]))];
  const localPaths = new Set(localFiles);

  return { missing, changed, identical, remoteOnly: remoteOnlyFiles(syncedDirs, localPaths) };
}

function upload(files) {
  let uploaded = 0;
  for (const file of files) {
    const absolute = path.join(ROOT, file);
    const directory = path.posix.dirname(file);
    if (directory && directory !== '.') {
      phoneSh(`mkdir -p ${quote(`${APP_DIR}/${directory}`)}`);
    }
    // Files are streamed over adb stdin so no temporary copy is left behind.
    phoneSh(`cat > ${quote(`${APP_DIR}/${file}`)}`, { input: fs.readFileSync(absolute) });
    uploaded += 1;
    if (uploaded % 10 === 0) process.stdout.write(`  ${uploaded}/${files.length} uploaded\n`);
  }
  return uploaded;
}

function restartApp() {
  phoneSh(`export PM2_HOME=${PM2_HOME} && export PATH=${TERMUX_BIN}:$PATH && cd ${quote(APP_DIR)} && node ${PM2_CLI} restart ${PM2_APP} --update-env`);
}

function showStartupLog(lines = 20) {
  return phoneSh(`tail -n ${lines} ${quote(`${APP_DIR}/logs/app-out.log`)}`);
}

function printReport(report) {
  console.log(`Device:  ${DEVICE}`);
  console.log(`App dir: ${APP_DIR}`);
  console.log(`Files:   ${report.identical.length} identical, ${report.changed.length} changed, ${report.missing.length} missing, ${report.remoteOnly.length} phone-only`);
  if (report.changed.length) {
    console.log('\nChanged on the phone (deploy will replace them):');
    for (const file of report.changed) console.log(`  ~ ${file}`);
  }
  if (report.missing.length) {
    console.log('\nMissing on the phone (deploy will add them):');
    for (const file of report.missing) console.log(`  + ${file}`);
  }
  if (report.remoteOnly.length) {
    console.log('\nOn the phone but not in the repo (left alone, review manually):');
    for (const file of report.remoteOnly.slice(0, 20)) console.log(`  ? ${file}`);
    if (report.remoteOnly.length > 20) console.log(`  ... and ${report.remoteOnly.length - 20} more`);
  }
  if (!report.changed.length && !report.missing.length) {
    console.log('\nNo drift: the phone matches this commit.');
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const deploy = args.includes('--deploy') && !dryRun;
  const restart = deploy && !args.includes('--no-restart');

  ensureDevice();
  const report = compare();
  printReport(report);

  const pending = [...report.missing, ...report.changed];
  if (!deploy) {
    if (pending.length) {
      console.log(`\nRun "npm run phone:deploy" to push ${pending.length} file(s).`);
      process.exitCode = 1;
    }
    return;
  }
  if (!pending.length) {
    console.log('\nNothing to upload.');
    if (!report.remoteOnly.length) return;
  }

  if (pending.length) {
    console.log(`\nUploading ${pending.length} file(s)...`);
    upload(pending);
  }

  const after = compare();
  if (after.changed.length || after.missing.length) {
    console.error(`\n❌ ${after.changed.length + after.missing.length} file(s) still differ after upload.`);
    process.exitCode = 1;
    return;
  }
  console.log('✅ Phone files now match this commit.');

  if (restart) {
    console.log(`Restarting ${PM2_APP}...`);
    restartApp();
    console.log('\nLast startup log lines:');
    console.log(showStartupLog(18));
  } else {
    console.log('Skipped restart; the running process still uses the old code.');
  }
}

try {
  main();
} catch (error) {
  console.error(`Phone deploy failed: ${error.message}`);
  process.exitCode = 1;
}
