const CONFIG_COLLECTION = 'system_config';
const CONFIG_DOCUMENT = 'backend_tunnel';
const ADMIN_APP_NAME = 'sb-power-phone-connection';
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=$|[\s/])/i;

function normalizePublicApiUrl(value) {
  const parsed = new URL(String(value || ''));
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    parsed.pathname !== '/' || parsed.search || parsed.hash
  ) {
    const error = new Error('Use a public HTTPS API origin without credentials, path, query, or hash.');
    error.code = 'invalid_public_api_url';
    throw error;
  }
  return parsed.origin;
}

function extractQuickTunnelUrl(line) {
  const match = String(line || '').replace(/\u001b\[[0-9;]*m/g, '').match(QUICK_TUNNEL_URL);
  return match ? normalizePublicApiUrl(match[0]) : '';
}

function createConnectionPublisher({ firestore }) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new TypeError('A Firestore client is required.');
  }

  const document = firestore.collection(CONFIG_COLLECTION).doc(CONFIG_DOCUMENT);
  return {
    async publish(apiUrl) {
      const publicApiUrl = normalizePublicApiUrl(apiUrl);
      const data = {
        apiUrl: publicApiUrl,
        updatedAt: new Date().toISOString(),
        status: 'online'
      };
      await document.set(data, { merge: true });
      return { success: true, ...data };
    },
    async setStatus(status, apiUrl) {
      if (!['online', 'offline', 'reconnecting'].includes(status)) {
        throw new TypeError('Tunnel status must be online, offline, or reconnecting.');
      }
      const data = { status, updatedAt: new Date().toISOString() };
      if (apiUrl) data.apiUrl = normalizePublicApiUrl(apiUrl);
      await document.set(data, { merge: true });
      return { success: true, ...data };
    }
  };
}

async function getAdminFirestore() {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const credentialsPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!projectId || !credentialsPath) {
    const error = new Error('Firebase project and service-account credentials are required.');
    error.code = 'firebase_connection_not_configured';
    throw error;
  }

  const fs = require('fs');
  if (!fs.existsSync(credentialsPath)) {
    const error = new Error('Firebase service-account credentials are unavailable.');
    error.code = 'firebase_connection_credentials_missing';
    throw error;
  }

  const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const app = getApps().find((item) => item.name === ADMIN_APP_NAME) || initializeApp({
    credential: applicationDefault(),
    projectId
  }, ADMIN_APP_NAME);
  return getFirestore(app);
}

async function getFirebaseCliAccessToken() {
  try {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const configPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
    if (!fs.existsSync(configPath)) return null;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const tokens = config && config.tokens;
    if (!tokens) return null;
    if (tokens.access_token && tokens.expires_at && tokens.expires_at > Date.now() + 60_000) {
      return tokens.access_token;
    }
    if (tokens.refresh_token) {
      try {
        const auth = require('firebase-tools/lib/auth');
        const refreshed = await auth.getAccessToken(tokens.refresh_token, []);
        if (refreshed && refreshed.access_token) return refreshed.access_token;
      } catch {
        // Fallback to access_token if refresh failed
      }
    }
    return tokens.access_token || null;
  } catch {
    return null;
  }
}

async function publishViaFirestoreRest(projectId, data) {
  const token = await getFirebaseCliAccessToken();
  if (!token) return null;

  const fields = {};
  const updateMasks = [];
  if (data.apiUrl) {
    fields.apiUrl = { stringValue: data.apiUrl };
    updateMasks.push('updateMask.fieldPaths=apiUrl');
  }
  if (data.status) {
    fields.status = { stringValue: data.status };
    updateMasks.push('updateMask.fieldPaths=status');
  }
  if (data.updatedAt) {
    fields.updatedAt = { stringValue: data.updatedAt };
    updateMasks.push('updateMask.fieldPaths=updatedAt');
  }
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${CONFIG_COLLECTION}/${CONFIG_DOCUMENT}?${updateMasks.join('&')}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`Firestore REST update failed: ${response.status} ${errorText}`);
    error.code = 'firestore_rest_update_failed';
    throw error;
  }
  return { success: true, ...data };
}

async function publishPhoneApiUrl(apiUrl) {
  const normalizedUrl = normalizePublicApiUrl(apiUrl);
  try {
    const firestore = await getAdminFirestore();
    return await createConnectionPublisher({ firestore }).publish(normalizedUrl);
  } catch (adminError) {
    const projectId = String(process.env.FIREBASE_PROJECT_ID || 'sb-power-marketplace').trim();
    if (projectId) {
      const restResult = await publishViaFirestoreRest(projectId, {
        apiUrl: normalizedUrl,
        updatedAt: new Date().toISOString(),
        status: 'online'
      });
      if (restResult) return restResult;
    }
    throw adminError;
  }
}

async function publishPhoneApiStatus(status, apiUrl) {
  if (!['online', 'offline', 'reconnecting'].includes(status)) {
    throw new TypeError('Tunnel status must be online, offline, or reconnecting.');
  }
  const normalizedUrl = apiUrl ? normalizePublicApiUrl(apiUrl) : undefined;
  try {
    const firestore = await getAdminFirestore();
    const publisher = createConnectionPublisher({ firestore });
    return await publisher.setStatus(status, normalizedUrl);
  } catch (adminError) {
    const projectId = String(process.env.FIREBASE_PROJECT_ID || 'sb-power-marketplace').trim();
    if (projectId) {
      const data = { status, updatedAt: new Date().toISOString() };
      if (normalizedUrl) data.apiUrl = normalizedUrl;
      const restResult = await publishViaFirestoreRest(projectId, data);
      if (restResult) return restResult;
    }
    throw adminError;
  }
}

module.exports = {
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT,
  normalizePublicApiUrl,
  extractQuickTunnelUrl,
  createConnectionPublisher,
  getAdminFirestore,
  publishPhoneApiUrl,
  publishPhoneApiStatus
};
