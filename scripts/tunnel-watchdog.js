#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// If local router / mobile carrier DNS fails to resolve tunnel or Firebase hosts,
// transparently fall back to Cloudflare (1.1.1.1) and Google (8.8.8.8) public DNS.
const originalDnsLookup = dns.lookup;
const fallbackResolver = new dns.Resolver();
try {
  fallbackResolver.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1']);
} catch {
  // Ignore if custom servers cannot be set
}

const PUBLIC_DNS_FALLBACK_SUFFIXES = [
  '.trycloudflare.com',
  'trycloudflare.com',
  '.lhr.life',
  'localhost.run',
  '.serveousercontent.com',
  'serveo.net',
  'googleapis.com'
];

function shouldUsePublicDnsFallback(hostname) {
  if (typeof hostname !== 'string') return false;
  const lower = hostname.toLowerCase();
  return PUBLIC_DNS_FALLBACK_SUFFIXES.some((suffix) =>
    lower === suffix || lower.endsWith(suffix) || lower.endsWith(`.${suffix}`)
  );
}

dns.lookup = function patchedDnsLookup(hostname, options, callback) {
  let cb = callback;
  let opts = options;
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  originalDnsLookup(hostname, opts, (err, address, family) => {
    if (err && shouldUsePublicDnsFallback(hostname)) {
      fallbackResolver.resolve4(hostname, (fallbackErr, addresses) => {
        if (!fallbackErr && addresses && addresses.length > 0) {
          if (opts && opts.all) {
            return cb(null, addresses.map((addr) => ({ address: addr, family: 4 })));
          }
          return cb(null, addresses[0], 4);
        }
        cb(err, address, family);
      });
      return;
    }
    cb(err, address, family);
  });
};

const {
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT,
  extractTunnelUrl,
  normalizePublicApiUrls,
  publishPhoneApiUrl,
  publishPhoneApiStatus
} = require('../src/firebaseConnection');

const PORT = Number(process.env.PORT || 3000);
const TERMUX_BIN_DIR = '/data/data/com.termux/files/usr/bin';
const TERMUX_LIB_DIR = '/data/data/com.termux/files/usr/lib';
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN ||
  (fs.existsSync(`${TERMUX_BIN_DIR}/cloudflared`) ? `${TERMUX_BIN_DIR}/cloudflared` : 'cloudflared');
const SSH_BIN = process.env.SSH_BIN ||
  (fs.existsSync(`${TERMUX_BIN_DIR}/ssh`) ? `${TERMUX_BIN_DIR}/ssh` : 'ssh');

const LOCAL_HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const HEALTH_INTERVAL_MS = 45_000;
const HEALTH_TIMEOUT_MS = 6_000;
const STARTUP_TIMEOUT_MS = 45_000;
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_CONSECUTIVE_REMOTE_FAILURES = 2;
const FIRESTORE_AUDIT_INTERVAL_MS = 5 * 60_000;

// Provider priority: localhost.run works reliably even when router/ISP DNS blocks
// *.trycloudflare.com; Cloudflare is kept active in parallel for mobile-data speed;
// Serveo acts as third independent backup.
const PROVIDER_ORDER = ['localhostrun', 'cloudflare', 'serveo'];

let stopping = false;
const activeChildren = new Set();
const providerUrls = new Map();
let lastPublishedPrimary = '';
let lastPublishedListKey = '';
let lastPublishedStatus = '';
let lastFirestoreSyncAt = 0;
let firestoreSynced = false;
let syncQueue = Promise.resolve();
let shutdownPromise = null;
let resolveStopping;
const stoppingPromise = new Promise((resolve) => { resolveStopping = resolve; });
const stopWaiters = new Set();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitOrStop(milliseconds) {
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      stopWaiters.delete(finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    stopWaiters.add(finish);
  });
}

function timeoutAfter(milliseconds, value) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(() => resolve(value), milliseconds); });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function fetchHealth(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return false;
    const health = await response.json();
    return Boolean(health && health.status === 'ok');
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function getOrderedHealthyUrls() {
  const raw = [];
  for (const name of PROVIDER_ORDER) {
    const url = providerUrls.get(name);
    if (url) raw.push(url);
  }
  return normalizePublicApiUrls(raw);
}

async function readPublishedTunnelState() {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || 'sb-power-marketplace').trim();
  if (!projectId) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${CONFIG_COLLECTION}/${CONFIG_DOCUMENT}`;
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    const doc = await response.json();
    const fields = doc && doc.fields;
    const apiUrls = fields && fields.apiUrls && fields.apiUrls.arrayValue && Array.isArray(fields.apiUrls.arrayValue.values)
      ? fields.apiUrls.arrayValue.values.map((v) => v && v.stringValue).filter(Boolean)
      : [];
    return {
      apiUrl: fields && fields.apiUrl && fields.apiUrl.stringValue ? fields.apiUrl.stringValue : '',
      apiUrls,
      status: fields && fields.status && fields.status.stringValue ? fields.status.stringValue : ''
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function enqueueFirestoreSync(fn) {
  syncQueue = syncQueue.then(fn, fn);
  return syncQueue;
}

async function publishCurrentState({ force = false, statusOverride = '' } = {}) {
  return enqueueFirestoreSync(async () => {
    const urls = getOrderedHealthyUrls();
    const primary = urls[0] || lastPublishedPrimary;
    const listKey = urls.join(',');
    const targetStatus = statusOverride || (urls.length > 0 ? 'online' : '');

    if (!targetStatus) return false;
    if (
      !force &&
      firestoreSynced &&
      targetStatus === lastPublishedStatus &&
      primary === lastPublishedPrimary &&
      listKey === lastPublishedListKey
    ) {
      return true;
    }

    try {
      if (targetStatus === 'online' && primary) {
        await publishPhoneApiUrl(primary, urls);
      } else {
        await publishPhoneApiStatus(targetStatus, primary || undefined, urls.length > 0 ? urls : undefined);
      }
      lastPublishedStatus = targetStatus;
      if (primary) lastPublishedPrimary = primary;
      if (listKey) lastPublishedListKey = listKey;
      lastFirestoreSyncAt = Date.now();
      firestoreSynced = true;
      console.log(`Synced Firestore (${targetStatus}): primary=${primary || 'none'} active=[${urls.join(', ')}]`);
      return true;
    } catch (error) {
      firestoreSynced = false;
      const code = error && error.code ? error.code : 'firestore_unavailable';
      console.error(`Firestore tunnel status update failed (${code}).`);
      return false;
    }
  });
}

function buildSpawnEnv() {
  const env = { ...process.env };
  if (fs.existsSync(TERMUX_BIN_DIR) && !(env.PATH || '').includes(TERMUX_BIN_DIR)) {
    env.PATH = `${TERMUX_BIN_DIR}:${env.PATH || '/usr/bin:/bin'}`;
  }
  if (fs.existsSync(TERMUX_LIB_DIR) && !(env.LD_LIBRARY_PATH || '').includes(TERMUX_LIB_DIR)) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${TERMUX_LIB_DIR}:${env.LD_LIBRARY_PATH}`
      : TERMUX_LIB_DIR;
  }
  return env;
}

function logOutput(stream, label, onLine) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (line) {
        onLine(line, label);
      }
    }
  });
  stream.on('end', () => {
    if (pending) {
      onLine(pending, label);
      pending = '';
    }
  });
}

function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5_000);
    forceTimer.unref();
    child.once('exit', () => {
      clearTimeout(forceTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function verifyTunnel(url, isAlive, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!stopping && isAlive() && Date.now() < deadline) {
    if (await fetchHealth(`${url}/health`)) return true;
    await sleep(2_000);
  }
  return false;
}

function getProviderCommand(providerName) {
  if (providerName === 'localhostrun') {
    return {
      bin: SSH_BIN,
      args: [
        '-T',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'BatchMode=yes',
        '-o', 'PasswordAuthentication=no',
        '-o', 'KbdInteractiveAuthentication=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-R', `80:127.0.0.1:${PORT}`,
        'nokey@localhost.run',
        '--',
        '--output', 'json'
      ],
      extractUrl(line) {
        const direct = extractTunnelUrl(line);
        if (direct) return direct;
        const trimmed = String(line || '').trim();
        if (trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed);
            const address = parsed && (parsed.address || (parsed.data && parsed.data.address));
            if (typeof address === 'string' && address.includes('.lhr.life')) {
              return `https://${address.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}`;
            }
          } catch {
            // Not JSON
          }
        }
        return '';
      },
      noisyPatterns: [/\u001b\[7m/, /\u001b\[49m/, /^Open your tunnel address/]
    };
  }

  if (providerName === 'serveo') {
    return {
      bin: SSH_BIN,
      args: [
        '-T',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'PasswordAuthentication=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-R', `80:127.0.0.1:${PORT}`,
        'serveo.net'
      ],
      extractUrl: (line) => extractTunnelUrl(line),
      noisyPatterns: []
    };
  }

  return {
    bin: CLOUDFLARED_BIN,
    args: ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'],
    extractUrl: (line) => extractTunnelUrl(line),
    noisyPatterns: [/ping_group_range/, /ICMP proxy feature is disabled/]
  };
}

function startProviderProcess(providerName) {
  const spec = getProviderCommand(providerName);
  console.log(`[${providerName}] Starting tunnel to 127.0.0.1:${PORT}.`);
  const child = spawn(spec.bin, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSpawnEnv()
  });
  activeChildren.add(child);

  let alive = true;
  let resolveExit;
  let resolveUrl;
  let foundUrl = '';
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
  const urlPromise = new Promise((resolve) => { resolveUrl = resolve; });

  function handleLine(line, label) {
    const isNoisy = spec.noisyPatterns.some((pattern) => pattern.test(line));
    if (!isNoisy && label !== 'qr') {
      const compact = line.length > 260 ? `${line.slice(0, 260)}...` : line;
      console.log(`[${providerName}:${label}] ${compact}`);
    }
    const url = spec.extractUrl(line);
    if (url && !foundUrl) {
      foundUrl = url;
      resolveUrl(url);
    }
  }

  child.once('error', (error) => {
    alive = false;
    activeChildren.delete(child);
    console.error(`[${providerName}] Could not start (${error.code || error.message}).`);
    resolveExit({ code: null, signal: null, error });
  });
  child.once('exit', (code, signal) => {
    alive = false;
    activeChildren.delete(child);
    console.log(`[${providerName}] Exited (code ${code === null ? 'none' : code}, signal ${signal || 'none'}).`);
    resolveExit({ code, signal });
  });
  logOutput(child.stdout, 'stdout', handleLine);
  logOutput(child.stderr, 'stderr', handleLine);

  return {
    child,
    exitPromise,
    urlPromise,
    isAlive: () => alive
  };
}

async function superviseProvider(providerName) {
  let backoffMs = INITIAL_BACKOFF_MS;

  while (!stopping) {
    // Wait until local Node app server is healthy before starting remote tunnels
    while (!stopping && !(await fetchHealth(LOCAL_HEALTH_URL))) {
      await waitOrStop(3_000);
    }
    if (stopping) break;

    const tunnel = startProviderProcess(providerName);
    const startupTimeout = timeoutAfter(STARTUP_TIMEOUT_MS, { timeout: true });

    const startupResult = await Promise.race([
      tunnel.urlPromise.then((url) => ({ url })),
      tunnel.exitPromise.then((exit) => ({ exit })),
      startupTimeout.promise,
      stoppingPromise.then(() => ({ stopping: true }))
    ]);
    startupTimeout.cancel();

    if (startupResult.exit && startupResult.exit.error && startupResult.exit.error.code === 'ENOENT') {
      console.error(`[${providerName}] Binary not installed; disabling this tunnel provider.`);
      return;
    }

    if (startupResult.url && tunnel.isAlive()) {
      const url = startupResult.url;
      const tunnelStartedAt = Date.now();
      console.log(`[${providerName}] Announced ${url}; verifying public /health.`);
      const reachable = await verifyTunnel(url, tunnel.isAlive);
      if (reachable && tunnel.isAlive()) {
        providerUrls.set(providerName, url);
        console.log(`[${providerName}] Healthy at ${url}.`);
        await publishCurrentState({ force: true });

        let consecutiveRemoteFailures = 0;
        let checkRunning = false;
        const healthTimer = setInterval(async () => {
          if (checkRunning || stopping || !tunnel.isAlive()) return;
          checkRunning = true;
          try {
            const localHealthy = await fetchHealth(LOCAL_HEALTH_URL);
            if (!localHealthy) {
              providerUrls.delete(providerName);
              await publishCurrentState();
              return;
            }
            const remoteHealthy = await fetchHealth(`${url}/health`);
            if (!remoteHealthy && tunnel.isAlive()) {
              consecutiveRemoteFailures += 1;
              if (consecutiveRemoteFailures < MAX_CONSECUTIVE_REMOTE_FAILURES) {
                console.warn(`[${providerName}] Public health failed (${consecutiveRemoteFailures}/${MAX_CONSECUTIVE_REMOTE_FAILURES}).`);
                return;
              }
              console.error(`[${providerName}] Public health failed repeatedly; restarting.`);
              providerUrls.delete(providerName);
              await publishCurrentState();
              await terminateChild(tunnel.child);
              return;
            }
            consecutiveRemoteFailures = 0;
            if (!providerUrls.has(providerName)) {
              providerUrls.set(providerName, url);
              await publishCurrentState();
            }
          } finally {
            checkRunning = false;
          }
        }, HEALTH_INTERVAL_MS);
        healthTimer.unref();

        await tunnel.exitPromise;
        clearInterval(healthTimer);
        providerUrls.delete(providerName);
        if (Date.now() - tunnelStartedAt >= 3 * 60_000) backoffMs = INITIAL_BACKOFF_MS;
      } else if (tunnel.isAlive()) {
        console.error(`[${providerName}] Announced URL ${url} did not pass /health before timeout.`);
        await terminateChild(tunnel.child);
      }
    } else if (startupResult.timeout && tunnel.isAlive()) {
      console.error(`[${providerName}] Startup timed out before URL appeared.`);
      await terminateChild(tunnel.child);
    }

    providerUrls.delete(providerName);
    if (stopping) break;
    await publishCurrentState();

    const jitterMs = Math.floor(Math.random() * Math.max(1, backoffMs / 4));
    console.log(`[${providerName}] Reconnecting in ${((backoffMs + jitterMs) / 1000).toFixed(1)}s.`);
    await waitOrStop(backoffMs + jitterMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

async function auditFirestoreLoop() {
  while (!stopping) {
    await waitOrStop(60_000);
    if (stopping) break;
    const urls = getOrderedHealthyUrls();
    if (urls.length === 0) continue;
    const primary = urls[0];
    if (!firestoreSynced || Date.now() - lastFirestoreSyncAt >= FIRESTORE_AUDIT_INTERVAL_MS) {
      const published = await readPublishedTunnelState();
      const publishedUrls = (published && Array.isArray(published.apiUrls) ? published.apiUrls : []).join(',');
      if (
        !published ||
        published.apiUrl !== primary ||
        published.status !== 'online' ||
        publishedUrls !== urls.join(',')
      ) {
        await publishCurrentState({ force: true });
      } else {
        lastFirestoreSyncAt = Date.now();
        firestoreSynced = true;
      }
    }
  }
}

async function superviseTunnel() {
  const enabledProviders = String(process.env.TUNNEL_PROVIDERS || PROVIDER_ORDER.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => PROVIDER_ORDER.includes(s));
  const providers = enabledProviders.length > 0 ? enabledProviders : PROVIDER_ORDER;

  console.log(`Multi-tunnel watchdog starting providers: ${providers.join(', ')}`);
  await Promise.all([
    ...providers.map((name) => superviseProvider(name)),
    auditFirestoreLoop()
  ]);
}

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  resolveStopping();
  for (const finishWait of [...stopWaiters]) finishWait();
  console.log(`Received ${signal}; stopping all tunnels.`);
  shutdownPromise = (async () => {
    await Promise.all([...activeChildren].map((child) => terminateChild(child)));
    await publishCurrentState({ force: true, statusOverride: 'offline' });
  })();
  return shutdownPromise;
}

if (require.main === module) {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exit(1);
  }
  process.once('SIGINT', () => { shutdown('SIGINT'); });
  process.once('SIGTERM', () => { shutdown('SIGTERM'); });
  superviseTunnel().catch((error) => {
    console.error('Tunnel watchdog stopped unexpectedly:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { fetchHealth, superviseTunnel, shutdown, getProviderCommand };
