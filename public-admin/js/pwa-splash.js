(() => {
  const splash = document.getElementById('startupSplash');
  if (!splash) return;

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    window.navigator.standalone === true;
  if (!isStandalone) {
    splash.remove();
    return;
  }

  document.documentElement.classList.add('is-standalone');
  const startedAt = performance.now();
  let finishQueued = false;
  const finishSplash = () => {
    if (finishQueued) return;
    finishQueued = true;
    const minimumDuration = 700;
    const remaining = Math.max(0, minimumDuration - (performance.now() - startedAt));
    window.setTimeout(() => {
      splash.classList.add('is-hidden');
      window.setTimeout(() => splash.remove(), 420);
    }, remaining);
  };

  if (document.readyState === 'complete') {
    finishSplash();
  } else {
    window.addEventListener('load', finishSplash, { once: true });
  }
  window.setTimeout(finishSplash, 2400);
})();
