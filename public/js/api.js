// Resolves the phone API origin from Firestore and retries safe reads while the
// phone or its tunnel is reconnecting. Mutating requests are never replayed.
(function (window) {
  const FIRESTORE_COLLECTION = 'system_config';
  const FIRESTORE_DOCUMENT = 'backend_tunnel';
  const API_CACHE_PREFIX = 'sb_active_phone_api_url:';
  const FIRESTORE_REQUEST_TIMEOUT_MS = 4000;
  const FIRESTORE_REFRESH_COOLDOWN_MS = 15_000;
  const CONNECTION_READY_TIMEOUT_MS = 5000;
  const nativeFetch = window.fetch.bind(window);

  function getFirebaseProjectId() {
    const configured = window.APP_CONFIG && window.APP_CONFIG.firebaseProjectId;
    if (typeof configured === 'string' && configured.trim()) return configured.trim();

    const hostname = String(window.location.hostname || '').toLowerCase();
    for (const suffix of ['.web.app', '.firebaseapp.com']) {
      if (hostname.endsWith(suffix)) return hostname.slice(0, -suffix.length).split('--')[0];
    }
    return '';
  }

  function normalizeApiOrigin(value) {
    try {
      const parsed = new URL(String(value || ''));
      if (
        parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash
      ) return '';
      return parsed.origin;
    } catch {
      return '';
    }
  }

  const firebaseProjectId = getFirebaseProjectId();
  let activeApiUrl = '';
  let backendStatus = 'unknown';
  let configFetchPromise = null;
  let lastConfigFetchAt = 0;
  let lastFailureRefreshAt = 0;
  let firstConnectionResolve;
  let firstConnectionResolved = false;
  const firstConnection = new Promise((resolve) => { firstConnectionResolve = resolve; });

  if (firebaseProjectId) {
    try {
      activeApiUrl = normalizeApiOrigin(localStorage.getItem(`${API_CACHE_PREFIX}${firebaseProjectId}`));
    } catch {
      // Storage can be unavailable in restricted WebViews.
    }
  }

  function resolveFirstConnection() {
    if (firstConnectionResolved) return;
    firstConnectionResolved = true;
    firstConnectionResolve(activeApiUrl);
  }

  function makeConnectionBanner() {
    if (!window.document || !window.document.body) return null;
    let banner = window.document.getElementById('sb-server-connection-status');
    if (banner) return banner;
    banner = window.document.createElement('div');
    banner.id = 'sb-server-connection-status';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    Object.assign(banner.style, {
      display: 'none',
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '10000',
      padding: '10px 14px',
      color: '#fff',
      background: '#92400e',
      textAlign: 'center',
      font: '500 14px/1.45 system-ui, sans-serif',
      boxShadow: '0 2px 8px rgba(0,0,0,.18)'
    });
    window.document.body.appendChild(banner);
    return banner;
  }

  function setConnectionState(state, message) {
    backendStatus = state;
    const banner = makeConnectionBanner();
    if (banner) {
      if (state === 'online') {
        banner.style.display = 'none';
        banner.textContent = '';
      } else {
        banner.textContent = message || (state === 'offline'
          ? 'ফোনের সার্ভার এই মুহূর্তে বন্ধ আছে। আবার সংযোগের চেষ্টা চলছে…'
          : 'ফোনের সার্ভারে সংযোগ ফিরিয়ে আনার চেষ্টা চলছে…');
        banner.style.display = 'block';
      }
    }
    if (typeof window.CustomEvent === 'function') {
      window.dispatchEvent(new window.CustomEvent('sb-api-connection', { detail: { status: state } }));
    }
  }

  function saveActiveApiUrl(apiUrl) {
    const normalized = normalizeApiOrigin(apiUrl);
    if (!normalized) return false;
    activeApiUrl = normalized;
    try {
      if (firebaseProjectId) localStorage.setItem(`${API_CACHE_PREFIX}${firebaseProjectId}`, activeApiUrl);
    } catch {
      // The current page can still use the freshly received value.
    }
    return true;
  }

  function applyFirestoreData(data) {
    if (!data || typeof data !== 'object') return;
    if (data.apiUrl) saveActiveApiUrl(data.apiUrl);
    const status = data.status === 'online' || data.status === 'offline' || data.status === 'reconnecting'
      ? data.status
      : 'unknown';
    if (status === 'online') setConnectionState('online');
    else if (status === 'offline') setConnectionState('offline');
    else if (status === 'reconnecting') setConnectionState('reconnecting');
    resolveFirstConnection();
  }

  async function readFirestoreRestDocument({ afterFailure = false } = {}) {
    if (!firebaseProjectId) return activeApiUrl;
    const now = Date.now();
    if (configFetchPromise) return configFetchPromise;
    if (afterFailure) {
      if (now - lastFailureRefreshAt < FIRESTORE_REFRESH_COOLDOWN_MS) return activeApiUrl;
      lastFailureRefreshAt = now;
    } else if (now - lastConfigFetchAt < FIRESTORE_REFRESH_COOLDOWN_MS) {
      return activeApiUrl;
    }
    lastConfigFetchAt = now;
    const documentUrl = new URL(
      `/v1/projects/${encodeURIComponent(firebaseProjectId)}/databases/(default)/documents/${FIRESTORE_COLLECTION}/${FIRESTORE_DOCUMENT}`,
      'https://firestore.googleapis.com'
    );
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), FIRESTORE_REQUEST_TIMEOUT_MS) : null;
    configFetchPromise = (async () => {
      try {
        const options = { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } };
        if (controller) options.signal = controller.signal;
        const response = await nativeFetch(documentUrl.href, options);
        if (!response.ok) return activeApiUrl;
        const document = await response.json();
        const fields = document && document.fields;
        applyFirestoreData({
          apiUrl: fields && fields.apiUrl && fields.apiUrl.stringValue,
          status: fields && fields.status && fields.status.stringValue
        });
        return activeApiUrl;
      } catch {
        return activeApiUrl;
      } finally {
        if (timeout) clearTimeout(timeout);
        configFetchPromise = null;
      }
    })();
    return configFetchPromise;
  }

  if (activeApiUrl) {
    resolveFirstConnection();
  } else if (firebaseProjectId) {
    readFirestoreRestDocument().finally(resolveFirstConnection);
  } else {
    resolveFirstConnection();
  }
  const connectionReady = Promise.race([
    firstConnection,
    new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(activeApiUrl), CONNECTION_READY_TIMEOUT_MS);
      if (typeof timeout.unref === 'function') timeout.unref();
    })
  ]);

  function getApiBaseUrl() {
    if (activeApiUrl) return activeApiUrl;
    const appConfig = window.APP_CONFIG || {};
    const devApiUrl = appConfig.VITE_DEV_API_URL || appConfig.devApiUrl || window.VITE_DEV_API_URL || '';
    if (devApiUrl) return String(devApiUrl).trim().replace(/\/+$/, '');
    if (appConfig.apiUrl) return String(appConfig.apiUrl).trim().replace(/\/+$/, '');
    try {
      const stored = localStorage.getItem('sb_api_base_url');
      if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
    } catch {
      // Ignore localStorage access issues in restricted WebViews.
    }

    const isNativeCapacitor =
      typeof window.Capacitor !== 'undefined' ||
      window.location.protocol === 'capacitor:' ||
      window.location.protocol === 'file:';
    if (isNativeCapacitor || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return `http://127.0.0.1:${Number(appConfig.devPort || 3000)}`;
    }
    return window.location.origin || '';
  }

  function apiUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    const base = getApiBaseUrl();
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return base ? `${base}${cleanPath}` : cleanPath;
  }

  function getRequestUrl(input) {
    if (input instanceof Request) return new URL(input.url, window.location.href);
    return new URL(String(input), window.location.href);
  }

  function retryDelay(attempt) {
    return new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 500 : 1500));
  }

  async function fetchApiWithRetry(input, init, destination) {
    const requestMethod = String((init && init.method) || (input instanceof Request && input.method) || 'GET').toUpperCase();
    const canRetry = ['GET', 'HEAD', 'OPTIONS'].includes(requestMethod);
    const maxAttempts = canRetry ? 3 : 1;
    const requestInit = init || {};
    let refreshedAfterFailure = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = input instanceof Request
          ? await nativeFetch(new Request(destination.href, input), init)
          : await nativeFetch(destination.href, init);
        if (response.status < 500) {
          setConnectionState('online');
          return response;
        }
        setConnectionState('reconnecting');
        if (!refreshedAfterFailure && firebaseProjectId) {
          refreshedAfterFailure = true;
          const previousApiUrl = activeApiUrl;
          await readFirestoreRestDocument({ afterFailure: true });
          if (activeApiUrl && activeApiUrl !== previousApiUrl) {
            destination = new URL(`${getRequestUrl(input).pathname}${getRequestUrl(input).search}`, `${activeApiUrl}/`);
          }
        }
        if (!canRetry || attempt === maxAttempts) return response;
      } catch (error) {
        setConnectionState('reconnecting');
        if (requestInit.signal && requestInit.signal.aborted) {
          setConnectionState('offline');
          throw error;
        }
        if (!refreshedAfterFailure && firebaseProjectId) {
          refreshedAfterFailure = true;
          const previousApiUrl = activeApiUrl;
          await readFirestoreRestDocument({ afterFailure: true });
          if (activeApiUrl && activeApiUrl !== previousApiUrl) {
            const requestUrl = getRequestUrl(input);
            destination = new URL(`${requestUrl.pathname}${requestUrl.search}`, `${activeApiUrl}/`);
          }
        }
        if (!canRetry || attempt === maxAttempts) {
          setConnectionState('offline');
          throw error;
        }
      }
      await retryDelay(attempt);
    }
    return nativeFetch(destination.href, init);
  }

  window.fetch = function (input, init) {
    let requestUrl;
    try {
      requestUrl = getRequestUrl(input);
    } catch {
      return nativeFetch(input, init);
    }
    if (requestUrl.pathname !== '/api' && !requestUrl.pathname.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    return connectionReady.then(() => {
      const baseUrl = getApiBaseUrl();
      if (!baseUrl) return nativeFetch(input, init);
      const destination = new URL(`${requestUrl.pathname}${requestUrl.search}`, `${baseUrl}/`);
      return fetchApiWithRetry(input, init, destination);
    });
  };

  window.SB_API = {
    getBaseUrl: getApiBaseUrl,
    url: apiUrl,
    connectionReady,
    getConnectionStatus: () => backendStatus,
    refreshConnection: () => readFirestoreRestDocument({ afterFailure: true }),
    setBaseUrl(newUrl) {
      try {
        if (!newUrl) localStorage.removeItem('sb_api_base_url');
        else localStorage.setItem('sb_api_base_url', newUrl.trim().replace(/\/+$/, ''));
      } catch {
        console.warn('Unable to persist API base URL.');
      }
    }
  };

  window.sbEscapeHtml = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
  };

  window.sbSafeImageUrl = function (value) {
    try {
      const raw = String(value || '').trim();
      if (!raw) return '/icons/icon-512.png';
      if (raw.startsWith('/uploads/')) {
        const parsedUpload = new URL(apiUrl(raw), window.location.origin);
        if (
          parsedUpload.protocol === 'https:' ||
          parsedUpload.origin === window.location.origin ||
          parsedUpload.hostname === '127.0.0.1' ||
          parsedUpload.hostname === 'localhost'
        ) {
          return parsedUpload.href;
        }
      }
      const parsed = new URL(raw, window.location.origin);
      if (parsed.protocol === 'https:' || parsed.origin === window.location.origin) return parsed.href;
    } catch {
      // Use a local icon when the value is not a safe URL.
    }
    return '/icons/icon-512.png';
  };

  window.sbImageCrossOrigin = function (value) {
    try {
      const raw = String(value || '').trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
      const parsed = new URL(raw, window.location.origin);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      if (parsed.origin === window.location.origin) return '';
      const apiOrigin = normalizeApiOrigin(getApiBaseUrl()) || '';
      if (apiOrigin && parsed.origin === apiOrigin) return 'anonymous';
      if (parsed.hostname.endsWith('.trycloudflare.com') && parsed.pathname.startsWith('/uploads/')) return 'anonymous';
    } catch {
      // Ignore malformed image URLs
    }
    return '';
  };

  window.sbImageCrossOriginAttr = function (value) {
    return window.sbImageCrossOrigin(value) === 'anonymous' ? 'crossorigin="anonymous"' : '';
  };

  window.sbHandleImageError = function (imgEl) {
    if (!imgEl || imgEl.dataset.sbFallbackApplied === '1') return;
    imgEl.dataset.sbFallbackApplied = '1';
    imgEl.onerror = null;
    imgEl.removeAttribute('crossorigin');
    imgEl.src = '/icons/icon-512.png';
  };

  window.apiUrl = apiUrl;
})(window);
