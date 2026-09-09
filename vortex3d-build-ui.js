/* Discoverable Vortex3D build controls for the Mobile Workspace shell. */
(() => {
  'use strict';

  function ensureRemoteBuilder() {
    if (window.Vortex3DRemoteBuilder) return;
    if (document.querySelector('script[data-vortex3d-remote-builder]')) return;
    const script = document.createElement('script');
    script.dataset.vortex3dRemoteBuilder = '1';
    script.src = new URL('vortex3d-remote-builder.js?v=3-delta-upload', location.href).href;
    script.async = false;
    document.head.appendChild(script);
  }

  function makeUiObvious() {
    const tokenInput = document.getElementById('tokenInput');
    const group = tokenInput?.closest('.input-group');
    const label = group?.querySelector('label');
    if (label) label.textContent = 'GitHub PAT (Vortex3D + VTXBuilder):';
    if (tokenInput) tokenInput.placeholder = 'Fine-grained PAT: Vortex3D Contents R/W + VTXBuilder Actions R/W';

    const config = document.getElementById('configPanel');
    const grid = config?.querySelector('.config-grid');
    if (grid && !document.getElementById('vortexPatHelp')) {
      const note = document.createElement('div');
      note.id = 'vortexPatHelp';
      note.className = 'gh-sync-card';
      note.innerHTML = '<div class="gh-sync-title">Vortex Build Access</div><div class="gh-sync-changes">Paste the fine-grained PAT above. This is NOT an Editor Actions secret. Select Arctic403/Vortex3d, pull the repo, edit locally, then use 🛠 Vortex Build in the toolbar. Vortex3D runs zero Actions; VTXBuilder owns the build.</div>';
      grid.appendChild(note);
    }

    if (!document.getElementById('vortexBuildVisibilityStyle')) {
      const style = document.createElement('style');
      style.id = 'vortexBuildVisibilityStyle';
      style.textContent = '#vortexRemoteBuildBtn{display:inline-flex!important}';
      document.head.appendChild(style);
    }
  }

  function boot() {
    makeUiObvious();
    ensureRemoteBuilder();
    let tries = 0;
    const tick = () => {
      makeUiObvious();
      const button = document.getElementById('vortexRemoteBuildBtn');
      if (button) {
        button.style.display = '';
        button.title = 'Select Arctic403/Vortex3d and click to sync only changed files, run VTXBuilder, and download the private result.';
        return;
      }
      if (tries++ < 100) setTimeout(tick, 50);
    };
    tick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
