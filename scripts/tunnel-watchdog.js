#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// If local router / mobile carrier DNS fails to resolve freshly announced trycloudflare.com
// hostnames, fallback to Cloudflare (1.1.1.1) and Google (8.8.8.8) public DNS resolvers.
const originalDnsLookup = dns.lookup;
const fallbackResolver = new dns.Resolver();
try {
  fallbackResolver.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1']);
} catch {
  // Ignore if custom servers cannot be set
}

dns.lookup = function patchedDnsLookup(hostname, options, callback) {
  let cb = callback;
  let opts = options;
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  originalDnsLookup(hostname, opts, (err, address, family) => {
    if (err && typeof hostname === 'string' && hostname.endsWith('.trycloudflare.com')) {
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
  extractQuickTunnelUrl,
  publishPhoneApiUrl,
  publishPhoneApiStatus
} = require('../src/firebaseConnection');

const PORT = Number(process.env.PORT || 3000);
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || 
  (fs.existsSync('/data/data/com.termux/files/usr/bin/cloudflared') 
    ? '/data/data/com.termux/files/usr/bin/cloudflared' 
    : 'cloudflared');
const LOCAL_HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const HEALTH_INTERVAL_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

let stopping = false;
let activeChild = null;
let activeTunnelUrl = '';
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
    return health && health.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function publishStatus(status, apiUrl = activeTunnelUrl) {
  try {
    if (status === 'online' && apiUrl) await publishPhoneApiUrl(apiUrl);
    else await publishPhoneApiStatus(status, apiUrl || undefined);
  } catch (error) {
    const code = error && error.code ? error.code : 'firestore_unavailable';
    console.error(`Firestore tunnel status update failed (${code}).`);
  }
}

function logOutput(stream, label, onLine) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (line) {
        console.log(`[cloudflared:${label}] ${line}`);
        onLine(line);
      }
    }
  });
  stream.on('end', () => {
    if (pending) {
      console.log(`[cloudflared:${label}] ${pending}`);
      onLine(pending);
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

function startCloudflared() {
  console.log(`Starting Quick Tunnel to 127.0.0.1:${PORT}.`);
  const child = spawn(CLOUDFLARED_BIN, [
    'tunnel',
    '--url', `http://127.0.0.1:${PORT}`,
    '--no-autoupdate'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let alive = true;
  let resolveExit;
  let resolveUrl;
  let foundUrl = '';
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
  const urlPromise = new Promise((resolve) => { resolveUrl = resolve; });

  function handleLine(line) {
    const url = extractQuickTunnelUrl(line);
    if (url && !foundUrl) {
      foundUrl = url;
      resolveUrl(url);
    }
  }

  child.once('error', (error) => {
    alive = false;
    console.error(`Could not start cloudflared (${error.code || error.name}).`);
    resolveExit({ code: null, signal: null, error });
  });
  child.once('exit', (code, signal) => {
    alive = false;
    console.log(`cloudflared exited (code ${code === null ? 'none' : code}, signal ${signal || 'none'}).`);
    resolveExit({ code, signal });
  });
  logOutput(child.stdout, 'stdout', handleLine);
  logOutput(child.stderr, 'stderr', handleLine);

  return {
    child,
    exitPromise,
    urlPromise,
    isAlive: () => alive,
    getFoundUrl: () => foundUrl
  };
}

async function superviseTunnel() {
  let backoffMs = INITIAL_BACKOFF_MS;

  while (!stopping) {
    await publishStatus(activeTunnelUrl ? 'reconnecting' : 'offline');
    const tunnel = startCloudflared();
    activeChild = tunnel.child;
    const startupTimeout = timeoutAfter(STARTUP_TIMEOUT_MS, { timeout: true });

    const startupResult = await Promise.race([
      tunnel.urlPromise.then((url) => ({ url })),
      tunnel.exitPromise.then((exit) => ({ exit })),
      startupTimeout.promise,
      stoppingPromise.then(() => ({ stopping: true }))
    ]);
    startupTimeout.cancel();

    if (startupResult.url && tunnel.isAlive()) {
      const url = startupResult.url;
      const tunnelStartedAt = Date.now();
      console.log(`Quick Tunnel announced ${url}; checking public /health.`);
      const reachable = await verifyTunnel(url, tunnel.isAlive);
      if (reachable && tunnel.isAlive()) {
        activeTunnelUrl = url;
        await publishStatus('online', url);
        console.log(`Public API is healthy at ${url}.`);
        let checkRunning = false;
        const healthTimer = setInterval(async () => {
          if (checkRunning || stopping || !tunnel.isAlive()) return;
          checkRunning = true;
          try {
            const localHealthy = await fetchHealth(LOCAL_HEALTH_URL);
            if (!localHealthy) {
              await publishStatus('reconnecting', activeTunnelUrl);
              return;
            }
            const remoteHealthy = await fetchHealth(`${activeTunnelUrl}/health`);
            if (!remoteHealthy && tunnel.isAlive()) {
              console.error('Public tunnel health check failed; restarting cloudflared.');
              await publishStatus('reconnecting', activeTunnelUrl);
              await terminateChild(tunnel.child);
            }
          } finally {
            checkRunning = false;
          }
        }, HEALTH_INTERVAL_MS);
        healthTimer.unref();
        await tunnel.exitPromise;
        clearInterval(healthTimer);
        if (Date.now() - tunnelStartedAt >= 5 * 60_000) backoffMs = INITIAL_BACKOFF_MS;
      } else if (tunnel.isAlive()) {
        console.error('The announced Quick Tunnel did not become healthy before timeout.');
        await terminateChild(tunnel.child);
      }
    } else if (startupResult.timeout && tunnel.isAlive()) {
      console.error('No Quick Tunnel URL appeared before timeout; restarting cloudflared.');
      await terminateChild(tunnel.child);
    }

    if (activeChild === tunnel.child) activeChild = null;
    if (stopping) break;
    await publishStatus('reconnecting', activeTunnelUrl);
    const jitterMs = Math.floor(Math.random() * Math.max(1, backoffMs / 4));
    console.log(`Restarting Quick Tunnel in ${(backoffMs + jitterMs) / 1000}s.`);
    await waitOrStop(backoffMs + jitterMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  resolveStopping();
  for (const finishWait of [...stopWaiters]) finishWait();
  console.log(`Received ${signal}; stopping the tunnel watchdog.`);
  shutdownPromise = (async () => {
    if (activeChild) await terminateChild(activeChild);
    await publishStatus('offline', activeTunnelUrl);
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

module.exports = { fetchHealth, superviseTunnel, shutdown };
