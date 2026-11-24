const fs = require('fs');
const path = require('path');

const CONFIG_FILES = [
  path.join('public', 'js', 'app-config.js'),
  path.join('public-admin', 'js', 'app-config.js')
];

function validateClientConfig({ projectId, apiKey, appId }) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(String(projectId || ''))) {
    throw new Error('Firebase project ID has an invalid format.');
  }
  if (typeof apiKey !== 'string' || apiKey.trim().length < 20 || /\s/.test(apiKey)) {
    throw new Error('Firebase Web API key is missing or malformed.');
  }
  if (typeof appId !== 'string' || appId.trim().length < 8 || /\s/.test(appId)) {
    throw new Error('Firebase Web App ID is missing or malformed.');
  }
  return {
    projectId: String(projectId),
    apiKey: apiKey.trim(),
    appId: appId.trim(),
    authDomain: `${projectId}.firebaseapp.com`
  };
}

function updateConfigContent(content, config) {
  const replacements = [
    ['firebaseProjectId', config.projectId, 'FIREBASE_PROJECT_ID'],
    ['firebaseApiKey', config.apiKey, 'FIREBASE_WEB_API_KEY (public Firebase web config)'],
    ['firebaseAppId', config.appId, 'FIREBASE_WEB_APP_ID'],
    ['firebaseAuthDomain', config.authDomain, 'FIREBASE_AUTH_DOMAIN (optional)']
  ];
  let updated = content;
  for (const [property, value, marker] of replacements) {
    const expression = new RegExp(`^window\\.APP_CONFIG\\.${property} = .*; \/\/ ${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
    const matches = updated.match(expression);
    if (!matches || matches.length !== 1) {
      throw new Error(`Firebase client setting ${property} was not found exactly once.`);
    }
    updated = updated.replace(expression, `window.APP_CONFIG.${property} = ${JSON.stringify(value)}; // ${marker}`);
  }
  return updated;
}

function configureFirebaseClient({ projectId, apiKey, appId, rootPath = path.join(__dirname, '..') }) {
  const config = validateClientConfig({ projectId, apiKey, appId });
  const files = CONFIG_FILES.map((relativePath) => {
    const filePath = path.join(rootPath, relativePath);
    const current = fs.readFileSync(filePath, 'utf8');
    return { filePath, updated: updateConfigContent(current, config) };
  });
  for (const file of files) fs.writeFileSync(file.filePath, file.updated, 'utf8');
  return { projectId: config.projectId, files: files.length };
}

if (require.main === module) {
  const [projectId, apiKey, appId] = process.argv.slice(2);
  if (!projectId || !apiKey || !appId) {
    console.error('Usage: node scripts/configure-firebase-client.js <project-id> <web-api-key> <web-app-id>');
    process.exit(2);
  }
  try {
    const result = configureFirebaseClient({ projectId, apiKey, appId });
    console.log(`Firebase Web App settings updated in ${result.files} frontend config files for ${result.projectId}.`);
  } catch (error) {
    console.error(`Firebase client config was not updated: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateClientConfig, updateConfigContent, configureFirebaseClient };
