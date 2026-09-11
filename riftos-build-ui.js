/* Discoverable RiftOS build controls for the Mobile Workspace shell. */
(() => {
  'use strict';

  function ensureRemoteBuilder() {
    if (window.RiftOSRemoteBuilder) return;
    if (document.querySelector('script[data-riftos-remote-builder]')) return;
    const script = document.createElement('script');
    script.dataset.riftosRemoteBuilder = '1';
    script.src = new URL('riftos-remote-builder.js?v=1-private-worker', location.href).href;
    script.async = false;
    document.head.appendChild(script);
  }

  function makeUiObvious() {
    const tokenInput = document.getElementById('tokenInput');
    const group = tokenInput?.closest('.input-group');
    const label = group?.querySelector('label');
    if (label) label.textContent = 'GitHub PAT (private source + public builders):';
    if (tokenInput) tokenInput.placeholder = 'Fine-grained PAT: source Contents R/W + builder Actions R/W';

    const config = document.getElementById('configPanel');
    const grid = config?.querySelector('.config-grid');
    if (grid && !document.getElementById('riftosPatHelp')) {
      const note = document.createElement('div');
      note.id = 'riftosPatHelp';
      note.className = 'gh-sync-card';
      note.innerHTML = '<div class="gh-sync-title">RiftOS Build Access</div><div class="gh-sync-changes">For RiftOS: grant this browser PAT Arctic403/RiftOS Contents R/W and Arctic403/Riftos-builder Actions R/W. Select RiftOS, pull the full repo, edit locally, then use 🛠 Rift Build. Private RiftOS runs zero Actions; the public builder owns the build.</div>';
      grid.appendChild(note);
    }
  }

  function boot() {
    makeUiObvious();
    ensureRemoteBuilder();
    let tries = 0;
    const tick = () => {
      makeUiObvious();
      const button = document.getElementById('riftosRemoteBuildBtn');
      if (button) {
        button.title = 'Select Arctic403/RiftOS and click to sync changed files, dispatch Riftos-builder, and retrieve the private verified APK.';
        return;
      }
      if (tries++ < 100) setTimeout(tick, 50);
    };
    tick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
