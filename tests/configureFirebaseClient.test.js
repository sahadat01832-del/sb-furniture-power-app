const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  configureFirebaseClient,
  updateConfigContent
} = require('../scripts/configure-firebase-client');

const CONFIG_TEMPLATE = [
  'window.APP_CONFIG = window.APP_CONFIG || {};',
  "window.APP_CONFIG.apiUrl = ''; // PHONE_SERVER_API_URL",
  "window.APP_CONFIG.firebaseProjectId = ''; // FIREBASE_PROJECT_ID",
  "window.APP_CONFIG.firebaseApiKey = ''; // FIREBASE_WEB_API_KEY (public Firebase web config)",
  "window.APP_CONFIG.firebaseAppId = ''; // FIREBASE_WEB_APP_ID",
  "window.APP_CONFIG.firebaseAuthDomain = ''; // FIREBASE_AUTH_DOMAIN (optional)",
  "window.APP_CONFIG.VITE_DEV_API_URL = ''; // VITE_DEV_API_URL / local development",
  'window.APP_CONFIG.devPort = 3000;'
].join('\n');

test('Firebase Web App settings update both frontend configs without changing other settings', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-firebase-client-'));
  try {
    for (const relativePath of ['public/js/app-config.js', 'public-admin/js/app-config.js']) {
      const filePath = path.join(rootPath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, CONFIG_TEMPLATE);
    }

    const result = configureFirebaseClient({
      rootPath,
      projectId: 'sb-power-demo',
      apiKey: 'AIzaSyExamplePublicWebApiKey000000000000000',
      appId: '1:123456789:web:abcdef123456'
    });

    assert.equal(result.files, 2);
    for (const relativePath of ['public/js/app-config.js', 'public-admin/js/app-config.js']) {
      const updated = fs.readFileSync(path.join(rootPath, relativePath), 'utf8');
      assert.match(updated, /firebaseProjectId = "sb-power-demo"/);
      assert.match(updated, /firebaseApiKey = "AIzaSyExamplePublicWebApiKey000000000000000"/);
      assert.match(updated, /firebaseAppId = "1:123456789:web:abcdef123456"/);
      assert.match(updated, /firebaseAuthDomain = "sb-power-demo\.firebaseapp\.com"/);
      assert.match(updated, /apiUrl = ''/);
    }
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});

test('Firebase config update refuses incomplete or unrecognized files', () => {
  assert.throws(() => updateConfigContent('window.APP_CONFIG = {};', {
    projectId: 'sb-power-demo',
    apiKey: 'AIzaSyExamplePublicWebApiKey000000000000000',
    appId: '1:123456789:web:abcdef123456',
    authDomain: 'sb-power-demo.firebaseapp.com'
  }), /not found exactly once/);
});
