/* Universal Android Single Player compatibility entry.
   Loads the validator/local-state layer, then the real APK build/download layer.
*/
(() => {
  'use strict';
  const core = document.createElement('script');
  core.src = new URL('android-single-player.js?v=2-universal-android', location.href).href;
  core.async = false;
  core.onload = () => {
    const builder = document.createElement('script');
    builder.src = new URL('android-apk-builder.js?v=1-real-apk', location.href).href;
    builder.async = false;
    document.head.appendChild(builder);
  };
  document.head.appendChild(core);
})();
