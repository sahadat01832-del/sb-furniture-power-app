// ============================================================
// SB Furniture & SB POWER — PWA Install Helper
// ============================================================

let deferredInstallPrompt = null;

// Detect standalone display mode (already installed as PWA or native webview)
function isRunningStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true ||
         document.referrer.includes('android-app://');
}

// 1. Listen for browser PWA install prompt
window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent browser default mini-infobar
  e.preventDefault();
  deferredInstallPrompt = e;

  // Reveal top navbar install button if present
  const navInstallBtn = document.getElementById('btnNavInstall');
  if (navInstallBtn && !isRunningStandalone()) {
    navInstallBtn.style.display = 'inline-flex';
  }

  // Show bottom floating banner if not previously dismissed in this session
  if (!isRunningStandalone() && !sessionStorage.getItem('sb_pwa_dismissed')) {
    setTimeout(() => {
      const banner = document.getElementById('pwaInstallBanner');
      if (banner) {
        banner.style.display = 'flex';
        requestAnimationFrame(() => banner.classList.add('show'));
      }
    }, 1500);
  }
});

// 2. Track when app has been installed
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) {
    banner.classList.remove('show');
    banner.style.display = 'none';
  }
  const navInstallBtn = document.getElementById('btnNavInstall');
  if (navInstallBtn) {
    navInstallBtn.style.display = 'none';
  }
  if (typeof showToast === 'function') {
    showToast('🎉 SB Furniture & SB POWER অ্যাপটি সফলভাবে আপনার ফোনে ইনস্টল হয়েছে!');
  }
});

// 3. Trigger 1-Click PWA Installation
async function triggerPwaInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      if (typeof showToast === 'function') {
        showToast('🚀 অ্যাপ ইনস্টলেশন শুরু হয়েছে...');
      }
      dismissPwaBanner();
    }
    deferredInstallPrompt = null;
  } else if (isRunningStandalone()) {
    if (typeof showToast === 'function') {
      showToast('✅ অ্যাপটি ইতিমধ্যেই আপনার ফোনে সফলভাবে ইনস্টল করা আছে!');
    }
  } else {
    // If browser does not support or hasn't fired beforeinstallprompt
    showPwaManualGuide();
  }
}

// 4. Dismiss Banner
function dismissPwaBanner() {
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) {
    banner.classList.remove('show');
    setTimeout(() => {
      banner.style.display = 'none';
    }, 400);
  }
  sessionStorage.setItem('sb_pwa_dismissed', '1');
}

// 5. Fallback Guide for Chrome / Safari Add to Home Screen
function showPwaManualGuide() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  let msg = '📲 ১-ক্লিকে ইনস্টল করতে ক্রোম ব্রাউজারের উপরে ডানদিকের তিনটি ডট (⋮) চাপুন এবং "Install app" বা "Add to Home screen" নির্বাচন করুন।';
  if (isIOS) {
    msg = '📲 আইফোনে ইনস্টল করতে সাফারির নিচে শেয়ার আইকন (Share) চেপে "Add to Home Screen" নির্বাচন করুন।';
  }
  if (typeof showToast === 'function') {
    showToast(msg);
  } else {
    alert(msg);
  }
}
