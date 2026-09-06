/* Universal Android Single Player compatibility entry.
   The legacy Ironvale browser/WASM adapter has been retired from the active Single Player button.
*/
(() => {
  'use strict';
  const script = document.createElement('script');
  script.src = new URL('android-single-player.js?v=1-universal-android', location.href).href;
  script.async = false;
  document.head.appendChild(script);
})();
