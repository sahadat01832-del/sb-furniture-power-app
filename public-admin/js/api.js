// Resolves the phone API origin from Firestore and retries safe reads while the
// phone or its tunnel is reconnecting. Mutating requests are never replayed.
(function (window) {
  const FIRESTORE_COLLECTION = 'system_config';
  const FIRESTORE_DOCUMENT = 'backend_tunnel';
  const FIRESTORE_SDK_VERSION = '13.4.0';
  const API_CACHE_PREFIX = 'sb_active_phone_api_url:';
  const FIRESTORE_REQUEST_TIMEOUT_MS = 4000;
  const FIRESTORE_POLL_INTERVAL_MS = 60_000;
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

  function getFirebaseClientConfig(projectId) {
    const appConfig = window.APP_CONFIG || {};
    const nested = appConfig.firebase || {};
    const apiKey = nested.apiKey || appConfig.firebaseApiKey || '';
    const appId = nested.appId || appConfig.firebaseAppId || '';
    if (!projectId || !apiKey || !appId) return null;
    return {
      apiKey: String(apiKey).trim(),
      appId: String(appId).trim(),
      projectId,
      authDomain: nested.authDomain || appConfig.firebaseAuthDomain || `${projectId}.firebaseapp.com`
    };
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
  const firebaseClientConfig = getFirebaseClientConfig(firebaseProjectId);
  let activeApiUrl = '';
  let backendStatus = 'unknown';
  let restPollTimer = null;
  let configFetchPromise = null;
  let lastConfigFetchAt = 0;
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

  async function readFirestoreRestDocument() {
    if (!firebaseProjectId) return activeApiUrl;
    const documentUrl = new URL(
      `/v1/projects/${encodeURIComponent(firebaseProjectId)}/databases/(default)/documents/${FIRESTORE_COLLECTION}/${FIRESTORE_DOCUMENT}`,
      'https://firestore.googleapis.com'
    );
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), FIRESTORE_REQUEST_TIMEOUT_MS) : null;
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
    }
  }

  function startRestPolling() {
    if (!firebaseProjectId || restPollTimer) return;
    readFirestoreRestDocument();
    restPollTimer = setInterval(readFirestoreRestDocument, FIRESTORE_POLL_INTERVAL_MS);
    if (typeof restPollTimer.unref === 'function') restPollTimer.unref();
  }

  function startRealtimeFirestoreListener() {
    if (!firebaseClientConfig || !firebaseProjectId) {
      startRestPolling();
      readFirestoreRestDocument().finally(resolveFirstConnection);
      return;
    }

    let listenerStarted = false;
    const importTimeout = setTimeout(() => {
      if (!listenerStarted) {
        startRestPolling();
        resolveFirstConnection();
      }
    }, 8000);

    Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FIRESTORE_SDK_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FIRESTORE_SDK_VERSION}/firebase-firestore.js`)
    ]).then(([appSdk, firestoreSdk]) => {
      clearTimeout(importTimeout);
      const appName = 'sb-phone-api-client';
      const app = appSdk.getApps().find((item) => item.name === appName) ||
        appSdk.initializeApp(firebaseClientConfig, appName);
      const firestore = firestoreSdk.getFirestore(app);
      const reference = firestoreSdk.doc(firestore, FIRESTORE_COLLECTION, FIRESTORE_DOCUMENT);
      listenerStarted = true;
      firestoreSdk.onSnapshot(reference, (snapshot) => {
        if (snapshot.exists()) applyFirestoreData(snapshot.data());
        else resolveFirstConnection();
      }, () => {
        startRestPolling();
        resolveFirstConnection();
      });
    }).catch(() => {
      clearTimeout(importTimeout);
      startRestPolling();
      readFirestoreRestDocument().finally(resolveFirstConnection);
    });
  }

  startRealtimeFirestoreListener();
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
        if (!canRetry || attempt === maxAttempts) return response;
      } catch (error) {
        setConnectionState('reconnecting');
        if (!canRetry || attempt === maxAttempts || (requestInit.signal && requestInit.signal.aborted)) {
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
    refreshConnection: () => readFirestoreRestDocument(),
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
      const parsed = new URL(String(value || ''), window.location.origin);
      if (parsed.protocol === 'https:' || parsed.origin === window.location.origin) return parsed.href;
    } catch {
      // Use a local icon when the value is not a safe URL.
    }
    return '/icons/icon-512.png';
  };

  window.apiUrl = apiUrl;
})(window);
