/* Universal Android Single Player compatibility entry.
   Loads the validator/local-state layer, the three-APK Fallpoint builder, and the
   Vortex3D local-controller/VTXBuilder bridge used by the main Editor shell.
*/
(() => {
  'use strict';

  const loadVortexBuilder = () => {
    if (document.querySelector('script[data-vortex3d-remote-builder]')) return;
    const remote = document.createElement('script');
    remote.dataset.vortex3dRemoteBuilder = '1';
    remote.src = new URL('vortex3d-remote-builder.js?v=1-local-controller', location.href).href;
    remote.async = false;
    document.head.appendChild(remote);
  };

  const core = document.createElement('script');
  core.src = new URL('android-single-player.js?v=2-universal-android', location.href).href;
  core.async = false;
  core.onload = () => {
    const builder = document.createElement('script');
    builder.src = new URL('android-apk-builder.js?v=2-three-apks', location.href).href;
    builder.async = false;
    document.head.appendChild(builder);
    loadVortexBuilder();
  };
  core.onerror = loadVortexBuilder;
  document.head.appendChild(core);
})();