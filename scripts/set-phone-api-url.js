const fs = require('fs');
const path = require('path');

const suppliedUrl = process.argv[2];
if (!suppliedUrl) {
  console.error('Usage: npm run phone:set-api -- https://your-stable-phone-api.example');
  process.exit(2);
}

let apiOrigin;
try {
  const parsed = new URL(suppliedUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Use a public HTTPS origin only, without credentials, path, query, or hash.');
  }
  apiOrigin = parsed.origin;
} catch (error) {
  console.error(`Invalid phone server URL: ${error.message}`);
  process.exit(2);
}

const rootPath = path.join(__dirname, '..');
const configPaths = [
  path.join(rootPath, 'public', 'js', 'app-config.js'),
  path.join(rootPath, 'public-admin', 'js', 'app-config.js')
];
const apiMarker = /^window\.APP_CONFIG\.apiUrl = .*; \/\/ PHONE_SERVER_API_URL$/m;
const projectMarker = /^window\.APP_CONFIG\.firebaseProjectId = .*; \/\/ FIREBASE_PROJECT_ID$/m;

let firebaseProjectId = '';
try {
  const firebaseConfig = JSON.parse(fs.readFileSync(path.join(rootPath, '.firebaserc'), 'utf8'));
  const defaultProjectId = firebaseConfig.projects && firebaseConfig.projects.default;
  if (typeof defaultProjectId === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(defaultProjectId)) {
    firebaseProjectId = defaultProjectId;
  }
} catch (error) {
  // Firebase Hosting can derive this ID from its web.app URL.
}

for (const configPath of configPaths) {
  const current = fs.readFileSync(configPath, 'utf8');
  if (!apiMarker.test(current) || !projectMarker.test(current)) {
    console.error(`The API or Firebase project setting was not found in ${path.relative(rootPath, configPath)}; no config files were changed.`);
    process.exit(1);
  }
}

for (const configPath of configPaths) {
  const current = fs.readFileSync(configPath, 'utf8');
  let next = current.replace(apiMarker, `window.APP_CONFIG.apiUrl = ${JSON.stringify(apiOrigin)}; // PHONE_SERVER_API_URL`);
  if (firebaseProjectId) {
    next = next.replace(projectMarker, `window.APP_CONFIG.firebaseProjectId = ${JSON.stringify(firebaseProjectId)}; // FIREBASE_PROJECT_ID`);
  }
  fs.writeFileSync(configPath, next, 'utf8');
}
console.log(`Phone API fallback set to ${apiOrigin}.${firebaseProjectId ? ` Firebase project ${firebaseProjectId} added for native apps.` : ''} Do not put passwords or tokens in this config.`);
