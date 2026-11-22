// ============================================================
// SB Furniture & SB POWER — Dynamic API URL Resolver & Cloud Connector
// Ensures the app NEVER loses connection to backend server,
// whether running in browser, PWA, Firebase Hosting, or Capacitor APK
// ============================================================

(function (window) {
  // Configurable Cloud Backend Default
  // When running inside Android Capacitor APK (localhost/file) or Firebase Hosting Spark plan,
  // this is the production server URL.
  const DEFAULT_CLOUD_API_URL = 'https://sb-furniture-power-app.onrender.com';

  function getApiBaseUrl() {
    // 1. Manually overridden in localStorage (e.g. via Server Settings)
    try {
      const stored = localStorage.getItem('sb_api_base_url');
      if (stored && stored.trim()) {
        return stored.trim().replace(/\/+$/, '');
      }
    } catch (e) {
      // Ignore localStorage access issues in restricted webviews
    }

    // 2. Injected via window.APP_CONFIG (if provided in deployment HTML)
    if (window.APP_CONFIG && window.APP_CONFIG.apiUrl) {
      return window.APP_CONFIG.apiUrl.trim().replace(/\/+$/, '');
    }

    // 3. Detect Capacitor Native App or local file environment
    const isNativeCapacitor =
      typeof window.Capacitor !== 'undefined' ||
      window.location.protocol === 'capacitor:' ||
      window.location.protocol === 'file:' ||
      (window.location.hostname === 'localhost' && window.location.port === '') ||
      (window.location.hostname === '127.0.0.1' && window.location.port === '');

    if (isNativeCapacitor) {
      return DEFAULT_CLOUD_API_URL;
    }

    // 4. Detect Firebase Hosting domain without Node.js backend
    if (
      window.location.hostname.endsWith('.web.app') ||
      window.location.hostname.endsWith('.firebaseapp.com')
    ) {
      return DEFAULT_CLOUD_API_URL;
    }

    // 5. Standard Web / Node.js Server: Use same origin
    return window.location.origin || '';
  }

  function apiUrl(path) {
    if (!path) return '';
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }
    const base = getApiBaseUrl();
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    return base ? `${base}${cleanPath}` : cleanPath;
  }

  window.SB_API = {
    getBaseUrl: getApiBaseUrl,
    url: apiUrl,
    setBaseUrl: function (newUrl) {
      try {
        if (!newUrl) {
          localStorage.removeItem('sb_api_base_url');
        } else {
          localStorage.setItem('sb_api_base_url', newUrl.trim().replace(/\/+$/, ''));
        }
      } catch (e) {
        console.warn('Unable to persist API base URL:', e);
      }
    }
  };

  window.apiUrl = apiUrl;
})(window);
