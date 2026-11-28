// Stable public entry point for the SB Power phone server.
//
// Customers and the admin panel talk to https://sb-power-api.<account>.workers.dev
// instead of a rotating quick-tunnel hostname. The Worker finds the phone's
// current tunnel in Firestore (the watchdog already publishes it there), proxies
// the request, and keeps a short-lived copy of the public catalog so browsing
// still works while the phone restarts.
//
// Security notes:
// - Only https origins under *.trycloudflare.com are accepted, so a tampered
//   Firestore document cannot turn this into an open proxy.
// - Only API/upload/download paths are proxied; the storefront HTML stays on
//   Firebase Hosting.
// - The real client IP is forwarded in a signed header so the phone's rate
//   limits keep working per customer instead of per Cloudflare edge IP.

const PROJECT_ID = 'sb-power-marketplace';
const FIRESTORE_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
  '/databases/(default)/documents/system_config/backend_tunnel';

const ORIGIN_CACHE_KEY = 'https://sb-power-proxy.internal/origin';
const CACHE_KEY_PREFIX = 'https://sb-power-proxy.internal/cache';
const ORIGIN_TTL_MS = 30_000;
const CATALOG_FRESH_MS = 60_000;
const CATALOG_STALE_MS = 24 * 60 * 60 * 1000;
const ORIGIN_HOST_SUFFIX = '.trycloudflare.com';
const STORED_AT_HEADER = 'X-SB-At';

const PROXY_HEADER = 'X-SB-Proxy';
const CACHE_HEADER = 'X-SB-Cache';
const CLIENT_IP_HEADER = 'X-SB-Client-IP';
const PROXY_TOKEN_HEADER = 'X-SB-Proxy-Token';

const RETRYABLE_STATUS = new Set([502, 503, 504, 530, 1033]);
const CACHEABLE_PATHS = new Set(['/api/products', '/api/products/meta/categories']);
const DIRECT_PATHS = new Set(['/health', '/status']);
const DIRECT_PATH_PREFIXES = ['/api/', '/uploads/', '/download/', '/dist-apk/'];
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
];

export function isAllowedOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash &&
      parsed.hostname.length > ORIGIN_HOST_SUFFIX.length &&
      parsed.hostname.endsWith(ORIGIN_HOST_SUFFIX)
    );
  } catch {
    return false;
  }
}

export function isAllowedPath(pathname) {
  return (
    DIRECT_PATHS.has(pathname) ||
    DIRECT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export function isCacheableRequest(method, pathname, headers) {
  return (
    method === 'GET' &&
    CACHEABLE_PATHS.has(pathname) &&
    !headers.get('authorization') &&
    !headers.get('cookie')
  );
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders
    }
  });
}

async function readCachedOrigin() {
  try {
    const cached = await caches.default.match(ORIGIN_CACHE_KEY);
    if (!cached) return null;
    const data = await cached.json();
    if (!isAllowedOrigin(data && data.url)) return null;
    return { url: data.url, at: Number(data.at) || 0 };
  } catch {
    return null;
  }
}

async function storeOrigin(url, at) {
  try {
    const response = new Response(JSON.stringify({ url, at }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }
    });
    await caches.default.put(ORIGIN_CACHE_KEY, response);
  } catch {
    // A failed cache write must never break the request.
  }
}

async function readOriginFromFirestore() {
  const response = await fetch(FIRESTORE_URL, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) throw new Error(`Firestore returned ${response.status}`);
  const document = await response.json();
  const url =
    document &&
    document.fields &&
    document.fields.apiUrl &&
    document.fields.apiUrl.stringValue;
  if (!isAllowedOrigin(url)) throw new Error('Published origin is not a valid tunnel URL');
  return String(url).replace(/\/+$/, '');
}

async function resolveOrigin({ bypassCache = false } = {}) {
  const cached = await readCachedOrigin();
  if (!bypassCache && cached && Date.now() - cached.at < ORIGIN_TTL_MS) {
    return { url: cached.url, at: cached.at, source: 'cache' };
  }
  try {
    const url = await readOriginFromFirestore();
    const at = Date.now();
    await storeOrigin(url, at);
    return { url, at, source: 'firestore' };
  } catch (error) {
    // Firestore unreachable: keep using the last known tunnel rather than
    // failing every request. The tunnel itself may still be healthy.
    if (cached) return { url: cached.url, at: cached.at, source: 'stale-cache' };
    throw error;
  }
}

function buildUpstreamHeaders(request, env) {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  headers.delete('host');
  headers.delete('content-length');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');
  headers.delete('x-forwarded-for');
  headers.delete('x-real-ip');
  headers.delete(CLIENT_IP_HEADER);
  headers.delete(PROXY_TOKEN_HEADER);
  // Ask the phone for the plain representation. Cloudflare compresses the
  // response for the browser at the edge, so the cached copy stays reusable.
  headers.set('accept-encoding', 'identity');

  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);
  if (env && env.PROXY_TOKEN) headers.set(PROXY_TOKEN_HEADER, env.PROXY_TOKEN);
  return headers;
}

function buildClientHeaders(upstreamHeaders) {
  const headers = new Headers(upstreamHeaders);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.set(PROXY_HEADER, '1');
  return headers;
}

async function callOrigin(request, origin, env) {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, `${origin}/`);
  const init = {
    method: request.method,
    headers: buildUpstreamHeaders(request, env),
    redirect: 'manual'
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
  }
  const upstream = await fetch(target.toString(), init);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildClientHeaders(upstream.headers)
  });
}

function isReplayable(method) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

async function proxyWithRetry(request, origin, env) {
  // The tunnel may have rotated between the Firestore read and now.
  const replayOnFreshOrigin = async () => {
    const fresh = await resolveOrigin({ bypassCache: true }).catch(() => null);
    if (!fresh || fresh.url === origin.url) return null;
    return callOrigin(request, fresh.url, env);
  };

  try {
    const response = await callOrigin(request, origin.url, env);
    if (!RETRYABLE_STATUS.has(response.status) || !isReplayable(request.method)) return response;
    return (await replayOnFreshOrigin()) || response;
  } catch (error) {
    if (!isReplayable(request.method)) throw error;
    const retried = await replayOnFreshOrigin();
    if (retried) return retried;
    throw error;
  }
}

function cachedAge(response) {
  return Date.now() - (Number(response.headers.get(STORED_AT_HEADER)) || 0);
}

function serveCached(response, { cacheState, maxAge, warning }) {
  const headers = new Headers(response.headers);
  headers.set(CACHE_HEADER, cacheState);
  headers.set('cache-control', `public, max-age=${maxAge}`);
  if (warning) headers.set('warning', warning);
  return new Response(response.body, { status: response.status, headers });
}

async function handleCacheable(request, origin, env, ctx) {
  const url = new URL(request.url);
  const cacheKey = new URL(`${CACHE_KEY_PREFIX}${url.pathname}${url.search}`);
  const cached = await caches.default.match(cacheKey);
  if (cached && cachedAge(cached) < CATALOG_FRESH_MS) {
    return serveCached(cached, { cacheState: 'HIT', maxAge: 30 });
  }

  try {
    const response = await proxyWithRetry(request, origin, env);
    if (response.status === 200 && !response.headers.get('set-cookie')) {
      const headers = new Headers(response.headers);
      headers.set(STORED_AT_HEADER, String(Date.now()));
      const snapshot = new Response(response.clone().body, { status: 200, headers });
      ctx.waitUntil(caches.default.put(cacheKey, snapshot).catch(() => {}));
    }
    const headers = new Headers(response.headers);
    headers.set(CACHE_HEADER, 'MISS');
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    // The phone is offline: keep serving the last good catalog for a day.
    if (cached && cachedAge(cached) < CATALOG_STALE_MS) {
      return serveCached(cached, {
        cacheState: 'STALE',
        maxAge: 15,
        warning: '110 - "Response is stale"'
      });
    }
    throw error;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      try {
        const origin = await resolveOrigin();
        return jsonResponse({
          ok: true,
          hasOrigin: true,
          originSource: origin.source,
          originAgeSeconds: Math.max(0, Math.round((Date.now() - origin.at) / 1000))
        });
      } catch {
        return jsonResponse({ ok: false, hasOrigin: false }, 503);
      }
    }

    if (!isAllowedPath(url.pathname)) {
      return jsonResponse({ success: false, message: 'Not found' }, 404);
    }

    try {
      const origin = await resolveOrigin();
      if (url.pathname === '/health') return await callOrigin(request, origin.url, env);
      if (isCacheableRequest(request.method, url.pathname, request.headers)) {
        return await handleCacheable(request, origin, env, ctx);
      }
      return await proxyWithRetry(request, origin, env);
    } catch (error) {
      const detail = String((error && error.message) || error).slice(0, 120);
      return jsonResponse({ success: false, message: 'Phone server unreachable', detail }, 503);
    }
  }
};
