(() => {
  'use strict';

  const root = document.documentElement;
  const displayMode = window.matchMedia?.('(display-mode: standalone)');
  const TOKEN_KEY = 'gh_token';
  const TOKEN_UI_ID = 'ghTokenPersistenceRow';
  const TOKEN_STATUS_ID = 'ghTokenPersistenceStatus';
  const TOKEN_FORGET_ID = 'ghTokenForgetBtn';

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

  function getSavedToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (err) {
      console.warn('Mobile Workspace could not read the saved GitHub token.', err);
      return '';
    }
  }

  function saveToken(token) {
    try {
      const clean = String(token || '').trim();
      if (clean) localStorage.setItem(TOKEN_KEY, clean);
      else localStorage.removeItem(TOKEN_KEY);
      return clean;
    } catch (err) {
      console.warn('Mobile Workspace could not save the GitHub token.', err);
      return '';
    }
  }

  function updateTokenStatus() {
    const status = document.getElementById(TOKEN_STATUS_ID);
    const forget = document.getElementById(TOKEN_FORGET_ID);
    if (!status) return;

    const saved = Boolean(getSavedToken());
    status.textContent = saved
      ? 'Saved on this device — restored when the Editor reopens.'
      : 'Not saved yet. Enter a token once and it will be kept on this device.';
    status.dataset.saved = saved ? 'true' : 'false';
    if (forget) forget.disabled = !saved;
  }

  function installTokenPersistenceUI() {
    const tokenInput = document.getElementById('tokenInput');
    if (!tokenInput) return;

    const savedToken = getSavedToken();
    if (savedToken && !tokenInput.value) {
      tokenInput.value = savedToken;
    }

    if (!document.getElementById(TOKEN_UI_ID)) {
      const inputGroup = tokenInput.closest('.input-group');
      if (inputGroup?.parentElement) {
        const row = document.createElement('div');
        row.id = TOKEN_UI_ID;
        row.className = 'gh-token-persistence-row';
        row.innerHTML = `
          <span id="${TOKEN_STATUS_ID}" class="gh-token-persistence-status"></span>
          <button id="${TOKEN_FORGET_ID}" class="btn btn-sm btn-secondary" type="button">Forget saved token</button>
        `;
        inputGroup.insertAdjacentElement('afterend', row);
      }
    }

    if (!document.getElementById('ghTokenPersistenceStyles')) {
      const style = document.createElement('style');
      style.id = 'ghTokenPersistenceStyles';
      style.textContent = `
        .gh-token-persistence-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 8px;
          border: 1px solid #3c3c3c;
          border-radius: 4px;
          background: rgba(14, 99, 156, 0.08);
        }
        .gh-token-persistence-status {
          flex: 1;
          min-width: 0;
          font-size: 0.72rem;
          line-height: 1.25;
          color: #9aa0a6;
        }
        .gh-token-persistence-status[data-saved="true"] {
          color: #6fd6a9;
        }
        .gh-token-persistence-row .btn {
          flex: 0 0 auto;
          white-space: nowrap;
        }
      `;
      document.head.appendChild(style);
    }

    if (!tokenInput.dataset.persistenceBound) {
      tokenInput.dataset.persistenceBound = 'true';
      tokenInput.addEventListener('input', () => {
        saveToken(tokenInput.value);
        updateTokenStatus();
      });
      tokenInput.addEventListener('change', () => {
        saveToken(tokenInput.value);
        updateTokenStatus();
      });
    }

    const forget = document.getElementById(TOKEN_FORGET_ID);
    if (forget && !forget.dataset.persistenceBound) {
      forget.dataset.persistenceBound = 'true';
      forget.addEventListener('click', () => {
        saveToken('');
        tokenInput.value = '';
        updateTokenStatus();
        tokenInput.focus();
      });
    }

    updateTokenStatus();
  }

  syncMode();
  syncViewport();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      syncThemeColor();
      installTokenPersistenceUI();
    }, { once: true });
  } else {
    syncThemeColor();
    installTokenPersistenceUI();
  }

  displayMode?.addEventListener?.('change', syncMode);
  window.addEventListener('resize', syncViewport, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(syncViewport, 120), { passive: true });
  window.addEventListener('pageshow', () => {
    syncMode();
    syncViewport();
    syncThemeColor();
    installTokenPersistenceUI();
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
    version: 2,
    standalone: isStandalone,
    syncViewport,
    tokenStorage: Object.freeze({
      key: TOKEN_KEY,
      saved: () => Boolean(getSavedToken()),
      forget: () => {
        saveToken('');
        updateTokenStatus();
      }
    })
  });
})();
