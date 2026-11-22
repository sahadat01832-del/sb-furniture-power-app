const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const app = require('../src/server');

let server;
let baseUrl;

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {}
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: json,
    text
  };
}

test.before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('APK & PWA 1: Web App Manifest & PNG Icons Compliance', async () => {
  const manifestRes = await request('/manifest.json');
  assert.equal(manifestRes.status, 200);
  assert.ok(manifestRes.body);
  assert.equal(manifestRes.body.display, 'standalone');
  assert.equal(manifestRes.body.name, 'SB Furniture & SB POWER');
  
  const icons = manifestRes.body.icons;
  assert.ok(Array.isArray(icons));
  const has192 = icons.some(i => i.src === '/icons/icon-192.png' && i.sizes === '192x192');
  const has512 = icons.some(i => i.src === '/icons/icon-512.png' && i.sizes === '512x512');
  assert.ok(has192, 'Manifest must declare 192x192 PNG icon for PWA installability');
  assert.ok(has512, 'Manifest must declare 512x512 PNG icon for PWA installability');

  const icon192Res = await request('/icons/icon-192.png');
  assert.equal(icon192Res.status, 200);
  assert.ok(icon192Res.headers['content-type'].includes('image/png'));
});

test('APK & PWA 2: PWA 1-Click Banner & APK Guidance Modal Assets', async () => {
  const cssRes = await request('/css/pwa-install.css');
  assert.equal(cssRes.status, 200);
  assert.ok(cssRes.text.includes('.pwa-install-banner'));
  assert.ok(cssRes.text.includes('.apk-guide-box'));

  const jsRes = await request('/js/pwa-install.js');
  assert.equal(jsRes.status, 200);
  assert.ok(jsRes.text.includes('beforeinstallprompt'));
  assert.ok(jsRes.text.includes('openApkDownloadModal'));
  assert.ok(jsRes.text.includes('triggerPwaInstall'));
});

test('APK & PWA 3: HTML Landing Page Integrates Zero-Friction PWA & Modal Guidance', async () => {
  const indexRes = await request('/');
  assert.equal(indexRes.status, 200);
  assert.ok(indexRes.text.includes('id="pwaInstallBanner"'));
  assert.ok(indexRes.text.includes('id="apkDownloadModal"'));
  assert.ok(indexRes.text.includes('id="btnNavInstall"'));
  assert.ok(indexRes.text.includes('openApkDownloadModal'));
  // Verify Bangla guidance text for conflict-free installation
  assert.ok(indexRes.text.includes('পুরনো অ্যাপ থাকলে আনইনস্টল করুন'));
  assert.ok(indexRes.text.includes('প্লে প্রোটেক্টে "Install anyway" চাপুন'));
});

test('APK & PWA 4: Production Keystore & Release APK Verification', () => {
  const rootDir = path.join(__dirname, '..');
  const keystorePath = path.join(rootDir, 'config', 'sb-release.keystore');
  assert.ok(fs.existsSync(keystorePath), 'Permanent release keystore must exist in config/');

  const resellerApk = path.join(rootDir, 'dist-apk', 'sb-power-reseller.apk');
  const adminApk = path.join(rootDir, 'dist-apk', 'sb-power-admin.apk');
  assert.ok(fs.existsSync(resellerApk), 'Reseller APK must exist');
  assert.ok(fs.existsSync(adminApk), 'Admin APK must exist');

  const resellerStat = fs.statSync(resellerApk);
  const adminStat = fs.statSync(adminApk);
  assert.ok(resellerStat.size > 1024 * 1024, 'Reseller APK size must be > 1MB');
  assert.ok(adminStat.size > 1024 * 1024, 'Admin APK size must be > 1MB');

  // Verify signature and debuggable state with Android SDK tools if present
  const apksigner = '/home/don/whynet ecosystem/NEWTUBE/NewTube_Android/.android-sdk/build-tools/35.0.0/apksigner';
  const aapt = '/home/don/whynet ecosystem/NEWTUBE/NewTube_Android/.android-sdk/build-tools/35.0.0/aapt';

  if (fs.existsSync(apksigner)) {
    const verifyOut = spawnSync(apksigner, ['verify', '-v', '--print-certs', resellerApk], { encoding: 'utf-8' });
    assert.equal(verifyOut.status, 0, 'apksigner verify must pass on reseller APK');
    assert.ok(verifyOut.stdout.includes('Verified using v2 scheme (APK Signature Scheme v2): true'));
    assert.ok(verifyOut.stdout.includes('Verified using v3 scheme (APK Signature Scheme v3): true'));
    assert.ok(verifyOut.stdout.includes('CN=SB Furniture & SB POWER'));
  }

  if (fs.existsSync(aapt)) {
    const badgingOut = spawnSync(aapt, ['dump', 'badging', resellerApk], { encoding: 'utf-8' });
    assert.equal(badgingOut.status, 0);
    assert.ok(!badgingOut.stdout.includes('application-debuggable'), 'Release APK must NOT have application-debuggable');
    assert.ok(badgingOut.stdout.includes("versionCode='2'"), 'Release APK must have bumped versionCode=2');
  }
});
