// Public deployment setting. The API URL is not a secret.
window.APP_CONFIG = window.APP_CONFIG || {};
// Stable Cloudflare Worker entry point. It finds the phone's current tunnel in
// Firestore on every request, so rotating tunnels never change this URL.
// A cached direct tunnel is still used as a fallback if the Worker is down.
window.APP_CONFIG.apiUrl = "https://sb-power-api.whynet-ecosystem.workers.dev"; // PHONE_SERVER_API_URL
window.APP_CONFIG.firebaseProjectId = "sb-power-marketplace"; // FIREBASE_PROJECT_ID
window.APP_CONFIG.firebaseApiKey = "AIzaSyCdyZrcAnEpX7QQDi614QR1bM90O7_rzZY"; // FIREBASE_WEB_API_KEY (public Firebase web config)
window.APP_CONFIG.firebaseAppId = "1:524721397981:web:eb7c40ec4fd6090379fb34"; // FIREBASE_WEB_APP_ID
window.APP_CONFIG.firebaseAuthDomain = "sb-power-marketplace.firebaseapp.com"; // FIREBASE_AUTH_DOMAIN (optional)
window.APP_CONFIG.devPort = 3000;
(function () {
  const hostname = window.location.hostname;
  const isCapacitorNative = Boolean(
    window.Capacitor &&
    (typeof window.Capacitor.isNativePlatform === 'function'
      ? window.Capacitor.isNativePlatform()
      : true)
  );
  const isLoopbackHttp = window.location.protocol === 'http:' &&
    (hostname === '127.0.0.1' || hostname === 'localhost');

  // Loopback HTTP dev talks to its own server; native Capacitor APKs stay on remote API.
  window.APP_CONFIG.VITE_DEV_API_URL = (!isCapacitorNative && isLoopbackHttp)
    ? `http://127.0.0.1:${window.APP_CONFIG.devPort}`
    : ''; // VITE_DEV_API_URL / local development override
})();
