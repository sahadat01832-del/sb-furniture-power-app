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

async function publishPhoneApiUrl(apiUrl) {
  const firestore = await getAdminFirestore();
  return createConnectionPublisher({ firestore }).publish(apiUrl);
}

async function publishPhoneApiStatus(status, apiUrl) {
  const firestore = await getAdminFirestore();
  const publisher = createConnectionPublisher({ firestore });
  return publisher.setStatus(status, apiUrl);
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
