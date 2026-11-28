const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_COLLECTION = 'system_config';
const CONFIG_DOCUMENT = 'backend_tunnel';
const ADMIN_APP_NAME = 'sb-power-phone-connection';
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=$|[\s/])/i;
const TUNNEL_URL_PATTERNS = [
  /https:\/\/[a-z0-9-]+\.(?:[a-z0-9-]+\.)?lhr\.life(?=$|[\s/"',])/i,
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=$|[\s/"',])/i,
  /https:\/\/[a-z0-9-]+\.serveousercontent\.com(?=$|[\s/"',])/i
];
const FIRESTORE_TIMEOUT_MS = 8000;

let cachedServiceAccountToken = null;

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

function normalizePublicApiUrls(values) {
  if (!Array.isArray(values)) return [];
  const unique = [];
  const seen = new Set();
  for (const raw of values) {
    if (!raw) continue;
    try {
      const normalized = normalizePublicApiUrl(raw);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(normalized);
      }
    } catch {
      // Skip malformed tunnel URLs when filtering candidate lists.
    }
  }
  return unique;
}

function extractQuickTunnelUrl(line) {
  const match = String(line || '').replace(/\u001b\[[0-9;]*m/g, '').match(QUICK_TUNNEL_URL);
  if (!match) return '';
  const url = normalizePublicApiUrl(match[0]);
  if (url === 'https://api.trycloudflare.com') return '';
  return url;
}

function extractTunnelUrl(line) {
  const clean = String(line || '').replace(/\u001b\[[0-9;]*m/g, '');
  for (const pattern of TUNNEL_URL_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      try {
        const url = normalizePublicApiUrl(match[0]);
        if (url === 'https://api.trycloudflare.com') continue;
        return url;
      } catch {
        // Continue checking remaining patterns
      }
    }
  }
  return '';
}

function withTimeout(promise, ms = FIRESTORE_TIMEOUT_MS) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Firestore operation timed out after ${ms}ms`);
      error.code = 'firestore_timeout';
      reject(error);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function createConnectionPublisher({ firestore }) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new TypeError('A Firestore client is required.');
  }

  const document = firestore.collection(CONFIG_COLLECTION).doc(CONFIG_DOCUMENT);
  return {
    async publish(apiUrl, apiUrls) {
      const publicApiUrl = normalizePublicApiUrl(apiUrl);
      const data = {
        apiUrl: publicApiUrl,
        updatedAt: new Date().toISOString(),
        status: 'online'
      };
      const normalizedUrls = normalizePublicApiUrls(apiUrls);
      if (normalizedUrls.length > 0) {
        data.apiUrls = normalizedUrls.includes(publicApiUrl)
          ? normalizedUrls
          : [publicApiUrl, ...normalizedUrls];
      }
      await withTimeout(document.set(data, { merge: true }));
      return { success: true, ...data };
    },
    async setStatus(status, apiUrl, apiUrls) {
      if (!['online', 'offline', 'reconnecting'].includes(status)) {
        throw new TypeError('Tunnel status must be online, offline, or reconnecting.');
      }
      const data = { status, updatedAt: new Date().toISOString() };
      if (apiUrl) data.apiUrl = normalizePublicApiUrl(apiUrl);
      const normalizedUrls = normalizePublicApiUrls(apiUrls);
      if (normalizedUrls.length > 0) {
        data.apiUrls = data.apiUrl && !normalizedUrls.includes(data.apiUrl)
          ? [data.apiUrl, ...normalizedUrls]
          : normalizedUrls;
      }
      await withTimeout(document.set(data, { merge: true }));
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

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getServiceAccountAccessToken() {
  try {
    if (cachedServiceAccountToken && cachedServiceAccountToken.expiresAt > Date.now() + 60_000) {
      return cachedServiceAccountToken.token;
    }
    const credentialsPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    if (!credentialsPath || !fs.existsSync(credentialsPath)) return null;
    const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    if (!creds || !creds.client_email || !creds.private_key) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const tokenEndpoint = creds.token_uri || 'https://oauth2.googleapis.com/token';
    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64UrlEncode(JSON.stringify({
      iss: creds.client_email,
      sub: creds.client_email,
      aud: tokenEndpoint,
      scope: 'https://www.googleapis.com/auth/datastore',
      iat: nowSec,
      exp: nowSec + 3600
    }));
    const unsigned = `${header}.${payload}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(creds.private_key);
    const assertion = `${unsigned}.${base64UrlEncode(signature)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FIRESTORE_TIMEOUT_MS);
    try {
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion
        }).toString()
      });
      if (!response.ok) return null;
      const body = await response.json();
      if (!body || !body.access_token) return null;
      cachedServiceAccountToken = {
        token: body.access_token,
        expiresAt: Date.now() + Math.max(60, Number(body.expires_in || 3600)) * 1000
      };
      return body.access_token;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

async function getFirebaseCliAccessToken() {
  try {
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
  const token = (await getServiceAccountAccessToken()) || (await getFirebaseCliAccessToken());
  if (!token) return null;

  const fields = {};
  const updateMasks = [];
  if (data.apiUrl) {
    fields.apiUrl = { stringValue: data.apiUrl };
    updateMasks.push('updateMask.fieldPaths=apiUrl');
  }
  if (Array.isArray(data.apiUrls)) {
    fields.apiUrls = {
      arrayValue: {
        values: data.apiUrls.map((url) => ({ stringValue: url }))
      }
    };
    updateMasks.push('updateMask.fieldPaths=apiUrls');
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRESTORE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });
    if (!response.ok) {
      if (response.status === 401) cachedServiceAccountToken = null;
      const errorText = await response.text();
      const error = new Error(`Firestore REST update failed: ${response.status} ${errorText}`);
      error.code = 'firestore_rest_update_failed';
      throw error;
    }
    return { success: true, ...data };
  } finally {
    clearTimeout(timer);
  }
}

async function publishPhoneApiUrl(apiUrl, apiUrls) {
  const normalizedUrl = normalizePublicApiUrl(apiUrl);
  const normalizedUrls = normalizePublicApiUrls(apiUrls);
  const projectId = String(process.env.FIREBASE_PROJECT_ID || 'sb-power-marketplace').trim();

  // Prefer Service Account HTTPS REST directly if available? Try Admin SDK with 8s timeout,
  // and immediately fall back to HTTPS REST (which avoids stalled gRPC channels on mobile Wi-Fi).
  try {
    const firestore = await getAdminFirestore();
    return await createConnectionPublisher({ firestore }).publish(normalizedUrl, normalizedUrls);
  } catch (adminError) {
    if (projectId) {
      const payload = {
        apiUrl: normalizedUrl,
        updatedAt: new Date().toISOString(),
        status: 'online'
      };
      if (normalizedUrls.length > 0) {
        payload.apiUrls = normalizedUrls.includes(normalizedUrl)
          ? normalizedUrls
          : [normalizedUrl, ...normalizedUrls];
      }
      const restResult = await publishViaFirestoreRest(projectId, payload);
      if (restResult) return restResult;
    }
    throw adminError;
  }
}

async function publishPhoneApiStatus(status, apiUrl, apiUrls) {
  if (!['online', 'offline', 'reconnecting'].includes(status)) {
    throw new TypeError('Tunnel status must be online, offline, or reconnecting.');
  }
  const normalizedUrl = apiUrl ? normalizePublicApiUrl(apiUrl) : undefined;
  const normalizedUrls = normalizePublicApiUrls(apiUrls);
  const projectId = String(process.env.FIREBASE_PROJECT_ID || 'sb-power-marketplace').trim();

  try {
    const firestore = await getAdminFirestore();
    const publisher = createConnectionPublisher({ firestore });
    return await publisher.setStatus(status, normalizedUrl, normalizedUrls);
  } catch (adminError) {
    if (projectId) {
      const data = { status, updatedAt: new Date().toISOString() };
      if (normalizedUrl) data.apiUrl = normalizedUrl;
      if (normalizedUrls.length > 0) {
        data.apiUrls = normalizedUrl && !normalizedUrls.includes(normalizedUrl)
          ? [normalizedUrl, ...normalizedUrls]
          : normalizedUrls;
      }
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
  normalizePublicApiUrls,
  extractQuickTunnelUrl,
  extractTunnelUrl,
  createConnectionPublisher,
  getAdminFirestore,
  publishPhoneApiUrl,
  publishPhoneApiStatus
};
