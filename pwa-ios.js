(() => {
  'use strict';

  const root = document.documentElement;
  const displayMode = window.matchMedia?.('(display-mode: standalone)');
  const isStandalone = () =>
    Boolean(window.navigator.standalone) || Boolean(displayMode?.matches);

  function syncMode() {
    const standalone = isStandalone();
    root.classList.toggle('mw-standalone', standalone);
    root.dataset.mobileWorkspaceDisplayMode = standalone ? 'standalone' : 'browser';
  }

  function syncViewport() {
    const viewport = window.visualViewport;
    const height = Math.max(
      1,
      Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 1)
    );
    root.style.setProperty('--mw-app-height', `${height}px`);

    const keyboardDelta = viewport
      ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
      : 0;
    root.classList.toggle('mw-keyboard-open', keyboardDelta > 120);
  }

  function syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const body = document.body;
    const color = body?.classList.contains('theme-light')
      ? '#f3f3f3'
      : body?.classList.contains('theme-monokai')
        ? '#1e1f1c'
        : '#11141a';
    meta.setAttribute('content', color);
  }

  syncMode();
  syncViewport();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncThemeColor, { once: true });
  } else {
    syncThemeColor();
  }

  displayMode?.addEventListener?.('change', syncMode);
  window.addEventListener('resize', syncViewport, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(syncViewport, 120), { passive: true });
  window.addEventListener('pageshow', () => {
    syncMode();
    syncViewport();
    syncThemeColor();
  });

  window.visualViewport?.addEventListener('resize', syncViewport, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncViewport, { passive: true });

  if (document.body) {
    new MutationObserver(syncThemeColor).observe(document.body, {
      attributes: true,
      attributeFilter: ['class']
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(syncThemeColor).observe(document.body, {
        attributes: true,
        attributeFilter: ['class']
      });
    }, { once: true });
  }

  window.__MOBILE_WORKSPACE_PWA__ = Object.freeze({
    version: 1,
    standalone: isStandalone,
    syncViewport
  });
})();
