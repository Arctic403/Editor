/* Adapts the legacy Single Player UI to the repo-agnostic Rift Survival Local Play contract. */
(() => {
  'use strict';
  const LEGACY_TARGET = 'Arctic403/Ironvale';
  const $ = id => document.getElementById(id);
  const actualRepo = () => $('repoSelect')?.value || 'current workspace';
  const actualBranch = () => $('branchSelect')?.value || 'local';

  function scrub(root) {
    if (!root) return;
    const repo = actualRepo();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const next = String(node.nodeValue || '')
        .replaceAll(LEGACY_TARGET, repo)
        .replaceAll('Ironvale', 'Rift Survival')
        .replaceAll('IRONVALE', 'SURVIVAL');
      if (next !== node.nodeValue) node.nodeValue = next;
    }
  }

  function patch() {
    const api = window.IronvaleLocalPlay;
    const modal = $('singlePlayerModal');
    const oldButton = $('singlePlayerBtn');
    if (!api || !modal || !oldButton) return false;

    window.RiftSurvivalLocalPlay = api;
    scrub(modal);
    new MutationObserver(() => scrub(modal)).observe(modal, { childList: true, subtree: true, characterData: true });

    const button = oldButton.cloneNode(true);
    oldButton.replaceWith(button);
    button.addEventListener('click', () => {
      scrub(modal);
      const status = $('singlePlayerStatus');
      if (status) status.textContent = `Ready for ${actualRepo()} (${actualBranch()}).\nPREPARE & PLAY detects the Rift Survival runtime; the repository name is no longer part of the test contract.`;
      modal.classList.remove('hidden');
    });

    const runButton = $('singlePlayerRun');
    if (runButton) runButton.onclick = async () => {
      // Drop any already-active legacy worker so PREPARE & PLAY cannot race a stale
      // backend emulator on the first launch after this upgrade. Cache/state survive.
      try {
        const base = new URL('./', location.href);
        const scope = new URL('__ironvale_local_play__/', base).href;
        const registration = await navigator.serviceWorker?.getRegistration?.(scope);
        if (registration) await registration.unregister();
      } catch (_) {}
      const select = $('repoSelect');
      const original = select?.value || '';
      let temporary = null;
      if (select && original !== LEGACY_TARGET) {
        temporary = document.createElement('option');
        temporary.value = LEGACY_TARGET;
        temporary.textContent = LEGACY_TARGET;
        temporary.hidden = true;
        select.appendChild(temporary);
        select.value = LEGACY_TARGET;
      }
      let promise;
      try { promise = api.run(); }
      finally {
        if (select) select.value = original;
        temporary?.remove();
      }
      try { await promise; }
      catch (error) {
        const status = $('singlePlayerStatus');
        if (status) status.textContent = 'Local Play failed:\n' + String(error?.message || error);
      }
      scrub(modal);
    };

    return true;
  }

  function boot() {
    let attempts = 0;
    const tryPatch = () => {
      if (patch() || attempts++ > 20) return;
      setTimeout(tryPatch, 50);
    };
    setTimeout(tryPatch, 0);
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
