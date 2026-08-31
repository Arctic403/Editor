/* Ironvale Local Play
   Runs the CURRENT LOCAL Arctic403/Ironvale workspace from the Editor.
   public/ assets are cached locally; changed native C++ is compiled to player-side WASM in-browser;
   the matching core backend is emulated by ironvale-local-play-sw.js.

   IMPORTANT: this is only the Local Play adapter. It does not modify the Editor,
   workspace manager, or JSON AI handoff.
*/
(() => {
  'use strict';

  const TARGET_REPO = 'Arctic403/Ironvale';
  const EDITOR_BASE_PATH = (() => {
    const path = new URL('./', location.href).pathname;
    return path.endsWith('/') ? path : path + '/';
  })();
  const PREVIEW_PREFIX = EDITOR_BASE_PATH + '__ironvale_local_play__/';
  const CACHE_NAME = 'ironvale-local-play-preview-v1';
  const NATIVE_CACHE_NAME = 'ironvale-local-native-build-v3';
  const NATIVE_COMPILER_VERSION = 'riftcore-local-v3';
  const NATIVE_COMPILER_WORKER = 'ironvale-native-compiler-worker.js?v=3-ios-network';
  const SAVE_FILENAME = 'ironvale-local-play-state.json';
  const MAX_FILES = 6000;
  const MAX_BYTES = 120 * 1024 * 1024;
  const CURRENT_NATIVE_BASELINE = Object.freeze([
    Object.freeze({ path: 'native/include/rift/terrain.hpp', gitBlobSha: 'd2e319a8e50bf2c33cab313ca0c259588f46ce3a' }),
    Object.freeze({ path: 'native/src/terrain.cpp', gitBlobSha: 'a488fe5fb15e88ad38c478bd08309787a4598619' })
  ]);
  let playRegistration = null;

  const $ = id => document.getElementById(id);
  function repo() { return $('repoSelect')?.value || ''; }
  function branch() { return $('branchSelect')?.value || ''; }

  async function saveDirtyEditor() {
    const editor = $('editor');
    const path = editor?.dataset?.filename || '';
    if (!path || typeof saveFileToDb !== 'function') return;
    if (typeof isDirty !== 'undefined' && !isDirty) return;
    await saveFileToDb(path, editor.value);
    if (typeof updateDirtyIndicator === 'function') updateDirtyIndicator(false);
  }

  function normalizePath(value) {
    const parts = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/');
    const out = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return out.join('/');
  }

  function isSecret(path) {
    const base = normalizePath(path).split('/').pop() || '';
    return /^(?:\.env)(?:\..*)?$/i.test(base)
      || /^(?:\.npmrc|\.pypirc|id_rsa|id_ed25519)$/i.test(base)
      || /\.(?:pem|key|p12|pfx)$/i.test(base);
  }

  function mimeFor(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    return ({
      html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
      ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', map: 'application/json', wasm: 'application/wasm'
    })[ext] || 'application/octet-stream';
  }

  function dataUrlResponse(content, path) {
    const match = String(content).match(/^data:([^;,]+)?;base64,([\s\S]+)$/i);
    if (!match) return null;
    const mime = match[1] || mimeFor(path);
    const binary = atob(match[2].replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Response(bytes, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' } });
  }

  async function collectWorkspace() {
    if (typeof getAllWorkspaceFiles !== 'function') throw new Error('Workspace read API is unavailable.');
    await saveDirtyEditor();
    const raw = await getAllWorkspaceFiles();
    if (raw.length > MAX_FILES) throw new Error(`Local Play supports up to ${MAX_FILES} files.`);

    const map = new Map();
    let total = 0;
    for (const file of raw) {
      const path = normalizePath(file?.name || '');
      if (!path || path.startsWith('.git/') || path.startsWith('node_modules/') || isSecret(path)) continue;
      const content = typeof file.content === 'string' ? file.content : String(file.content ?? '');
      total += content.length;
      if (total > MAX_BYTES) throw new Error('Workspace is too large for browser Local Play.');
      map.set(path, content);
    }
    return map;
  }

  function nativeWorkspaceFiles(files) {
    return [...files.entries()]
      .filter(([path]) => path.startsWith('native/') && /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(path))
      .map(([path, content]) => ({ path, content }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async function nativeFingerprint(nativeFiles) {
    const encoder = new TextEncoder();
    const text = [NATIVE_COMPILER_VERSION, ...nativeFiles.flatMap(file => [file.path, file.content])].join('\0');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function gitBlobSha(content) {
    const encoder = new TextEncoder();
    const body = encoder.encode(String(content ?? ''));
    const header = encoder.encode(`blob ${body.byteLength}\0`);
    const bytes = new Uint8Array(header.byteLength + body.byteLength);
    bytes.set(header, 0);
    bytes.set(body, header.byteLength);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function committedSourceManifest(files) {
    try {
      const raw = files.get('public/rift-core.sources.json');
      if (!raw) return CURRENT_NATIVE_BASELINE;
      const parsed = JSON.parse(raw);
      if (parsed?.format !== 'rift-core-sources-v1' || !Array.isArray(parsed.sources)) return CURRENT_NATIVE_BASELINE;
      return parsed.sources
        .map(item => ({ path: normalizePath(item?.path), gitBlobSha: String(item?.gitBlobSha || '').toLowerCase() }))
        .filter(item => item.path && /^[a-f0-9]{40}$/.test(item.gitBlobSha))
        .sort((a, b) => a.path.localeCompare(b.path));
    } catch {
      return CURRENT_NATIVE_BASELINE;
    }
  }

  async function nativeMatchesCommittedSources(files, nativeFiles) {
    const expected = committedSourceManifest(files);
    if (expected.length !== nativeFiles.length) return false;
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i].path !== nativeFiles[i].path) return false;
      if (await gitBlobSha(nativeFiles[i].content) !== expected[i].gitBlobSha) return false;
    }
    return true;
  }

  async function validateNativeWasm(bytes) {
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, {});
    const e = instance.exports;
    if (!e.memory || typeof e.rift_core_version !== 'function' || e.rift_core_version() !== 1) {
      throw new Error('Local C++ build has an invalid RiftCore ABI.');
    }
    if (typeof e.rift_terrain_init !== 'function' || e.rift_terrain_init(641, 641, 1, 0, 0, 0, .82) !== 1) {
      throw new Error('Local C++ build failed RiftCore terrain initialization.');
    }
    const before = Number(e.rift_terrain_sample_height?.(320, 320));
    if (!Number.isFinite(before) || Math.abs(before) > .001) throw new Error('Local C++ build failed flat-terrain sampling.');
    if (e.rift_terrain_apply_brush?.(0, 320, 320, 8, .5, 0) !== 1) throw new Error('Local C++ build failed terrain sculpt self-test.');
    const after = Number(e.rift_terrain_sample_height?.(320, 320));
    if (!(after > before)) throw new Error('Local C++ build produced invalid sculpt math.');
    if (e.rift_terrain_build_chunk?.(0, 0, 64, 2) !== 1 || Number(e.rift_mesh_index_count?.()) <= 0) {
      throw new Error('Local C++ build failed chunk meshing self-test.');
    }
    if (e.rift_terrain_raycast?.(32, 50, 32, 0, -1, 0, 100, .5) !== 1) {
      throw new Error('Local C++ build failed terrain raycast self-test.');
    }
    return true;
  }

  async function compileNativeWorkspace(files, log) {
    const nativeFiles = nativeWorkspaceFiles(files);
    const sources = nativeFiles.filter(file => /\.(?:cc|cpp|cxx)$/i.test(file.path));
    if (!sources.length) {
      log('Native: no C++ sources; using the committed player WASM artifact.');
      return null;
    }

    if (await nativeMatchesCommittedSources(files, nativeFiles)) {
      try { await caches.delete('ironvale-local-native-build-v1'); } catch {}
      log('Native: C++ matches the committed RiftCore sources; using the exact production WASM.');
      return null;
    }

    const fingerprint = await nativeFingerprint(nativeFiles);
    const nativeCache = await caches.open(NATIVE_CACHE_NAME);
    const cacheUrl = location.origin + EDITOR_BASE_PATH + '__ironvale_native_build__/' + fingerprint + '.wasm';
    const cached = await nativeCache.match(cacheUrl);
    if (cached) {
      const bytes = await cached.arrayBuffer();
      await validateNativeWasm(bytes);
      log(`Native: cached changed-C++ build ${fingerprint.slice(0, 8)} (${(bytes.byteLength / 1024).toFixed(1)} KB).`);
      return bytes;
    }

    log(`Native: source differs from production; compiling ${sources.length} C++ source file${sources.length === 1 ? '' : 's'} on-device…`);
    const worker = new Worker(new URL(NATIVE_COMPILER_WORKER, location.href));
    const buffer = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error('Local C++ compiler stopped responding.'));
      }, 180000);

      worker.onmessage = event => {
        const data = event.data || {};
        if (data.type === 'progress') {
          const message = String(data.message || '').trim();
          if (message) log('Native: ' + message);
          return;
        }
        if (data.type === 'done') {
          clearTimeout(timeout);
          worker.terminate();
          resolve(data.buffer);
          return;
        }
        if (data.type === 'error') {
          clearTimeout(timeout);
          worker.terminate();
          reject(new Error(data.error || 'Local C++ build failed.'));
        }
      };
      worker.onerror = event => {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message || 'Local C++ compiler worker crashed.'));
      };
      worker.postMessage({ type: 'compile', files: nativeFiles });
    });

    const bytes = buffer instanceof ArrayBuffer ? buffer : buffer?.buffer;
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength) throw new Error('Local C++ build returned no WASM bytes.');
    await validateNativeWasm(bytes);
    await nativeCache.put(cacheUrl, new Response(bytes.slice(0), {
      headers: { 'Content-Type': 'application/wasm', 'Cache-Control': 'no-store' }
    }));
    log(`Native: fresh changed-C++ RiftCore WASM passed self-test (${(bytes.byteLength / 1024).toFixed(1)} KB).`);
    return bytes;
  }

  function injectLocalPlayBridge(html) {
    const script = `<script>\nwindow.__IRONVALE_LOCAL_PLAY__=true;\nwindow.__IRONVALE_LOCAL_PLAY_PREFIX__=${JSON.stringify(PREVIEW_PREFIX)};\n<\/script>`;
    const badge = `<style id="ironvale-local-play-badge">body:after{content:"IRONVALE · LOCAL PLAY";position:fixed;z-index:2147483647;right:8px;bottom:8px;padding:6px 9px;border-radius:8px;background:rgba(5,18,11,.84);color:#bff7cf;border:1px solid rgba(74,222,128,.48);font:800 10px system-ui;letter-spacing:.07em;pointer-events:none}</style>`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${script}${badge}`);
    return script + badge + html;
  }

  async function populatePreviewCache(files, log, nativeWasm = null) {
    if (!files.has('public/index.html')) throw new Error('Ironvale public/index.html is missing from the local workspace.');
    const publicFiles = [...files.entries()].filter(([path]) => path.startsWith('public/'));
    const cache = await caches.open(CACHE_NAME);
    const old = await cache.keys();
    await Promise.all(old.map(request => cache.delete(request)));

    let count = 0;
    for (const [path, content] of publicFiles) {
      const rel = path.slice('public/'.length);
      if (!rel) continue;
      let response = dataUrlResponse(content, rel);
      if (!response) {
        const text = rel === 'index.html' ? injectLocalPlayBridge(content) : content;
        response = new Response(text, { headers: { 'Content-Type': mimeFor(rel), 'Cache-Control': 'no-store' } });
      }
      await cache.put(new Request(location.origin + PREVIEW_PREFIX + rel), response);
      count += 1;
    }

    if (nativeWasm) {
      await cache.put(new Request(location.origin + PREVIEW_PREFIX + 'rift-core.wasm.gz'), new Response(nativeWasm.slice(0), {
        headers: { 'Content-Type': 'application/wasm', 'Cache-Control': 'no-store', 'X-Ironvale-Local-Native-Build': '1' }
      }));
      log('Native: preview is using the freshly compiled changed-source player-side WASM.');
    }
    log(`Prepared ${count} Ironvale public asset(s) from the local workspace.`);
  }

  function waitForActive(registration) {
    if (registration.active?.state === 'activated') return Promise.resolve(registration.active);
    const worker = registration.installing || registration.waiting || registration.active;
    if (!worker) return Promise.reject(new Error('Ironvale Local Play service worker failed to start.'));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out activating Ironvale Local Play.')), 5000);
      const done = () => {
        if (worker.state !== 'activated') return;
        clearTimeout(timeout);
        worker.removeEventListener('statechange', done);
        resolve(worker);
      };
      worker.addEventListener('statechange', done);
      done();
    });
  }

  async function ensureServiceWorker(log = () => {}) {
    if (!('serviceWorker' in navigator)) throw new Error('This browser does not support Service Workers.');
    log('Starting isolated Ironvale local backend…');
    const workerUrl = new URL('ironvale-local-play-sw.js?v=2', location.href);
    const registration = await navigator.serviceWorker.register(workerUrl.href, { scope: PREVIEW_PREFIX });
    await waitForActive(registration);
    playRegistration = registration;
    return registration;
  }

  async function workerMessage(type, payload = null) {
    const registration = playRegistration || await ensureServiceWorker();
    const worker = registration.active || await waitForActive(registration);
    const channel = new MessageChannel();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Ironvale Local Play backend did not respond.')), 3000);
      channel.port1.onmessage = event => {
        clearTimeout(timeout);
        if (event.data?.ok === false) reject(new Error(event.data.error || 'Local Play request failed.'));
        else resolve(event.data);
      };
      worker.postMessage({ type, payload }, [channel.port2]);
    });
  }

  function previewUrl() { return location.origin + PREVIEW_PREFIX + 'index.html'; }
  function openPreview() { window.open(previewUrl(), '_blank', 'noopener,noreferrer'); }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function ensureModal() {
    if ($('singlePlayerModal')) return;
    const style = document.createElement('style');
    style.textContent = `
      .single-player-overlay{position:fixed;inset:0;z-index:211000;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(2,6,12,.80)}
      .single-player-overlay.hidden{display:none}.single-player-card{width:min(700px,100%);max-height:92dvh;overflow:auto;background:#10161f;color:#edf4fb;border:1px solid #335044;border-radius:16px;padding:16px;box-sizing:border-box}
      .single-player-head{display:flex;justify-content:space-between;gap:10px}.single-player-head h2{margin:0;font-size:18px}.single-player-head p{margin:4px 0 0;color:#9eb8aa;font-size:12px}
      .single-player-close{width:38px;height:38px;border:1px solid #435c50;border-radius:9px;background:#18271f;color:white}
      .single-player-note{margin:12px 0;padding:10px;border:1px solid #2d6140;border-radius:10px;background:#0b2415;font-size:12px;line-height:1.5}
      .single-player-status{min-height:92px;padding:10px;border:1px solid #2d4737;border-radius:10px;background:#090f0b;white-space:pre-wrap;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
      .single-player-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.single-player-actions button,.single-player-actions label{flex:1 1 140px;border:0;border-radius:10px;padding:11px 12px;font-weight:800;text-align:center;box-sizing:border-box;cursor:pointer}
      .single-player-run{background:#22c55e;color:#07150b}.single-player-open{background:#26734a;color:white}.single-player-secondary{background:#283b31;color:#e9f8ef}.single-player-danger{background:#63252b;color:#ffd8dc}.single-player-actions button:disabled{opacity:.45}
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'singlePlayerModal';
    overlay.className = 'single-player-overlay hidden';
    overlay.innerHTML = `
      <section class="single-player-card">
        <div class="single-player-head">
          <div><h2>🎮 Ironvale Local Play</h2><p>Local frontend + changed C++→WASM + browser-emulated backend.</p></div>
          <button id="singlePlayerClose" class="single-player-close" type="button">×</button>
        </div>
        <div class="single-player-note">
          <b>Deploy-free native test sandbox.</b> PREPARE & PLAY reads the current Ironvale workspace. Native source fingerprints are compared to the committed RiftCore build: unchanged C++ uses the exact production WASM, while genuinely changed C++ is compiled in-browser and self-tested before the preview can use it. The Editor, JSON AI handoff, production Worker, D1 and deployed game are untouched.
        </div>
        <div id="singlePlayerStatus" class="single-player-status">Ready.</div>
        <div class="single-player-actions">
          <button id="singlePlayerRun" class="single-player-run" type="button">PREPARE & PLAY</button>
          <button id="singlePlayerOpen" class="single-player-open" type="button">OPEN LOCAL PLAY</button>
          <button id="singlePlayerExport" class="single-player-secondary" type="button">EXPORT LOCAL STATE</button>
          <label class="single-player-secondary">IMPORT LOCAL STATE<input id="singlePlayerImportInput" type="file" accept=".json,application/json" hidden></label>
          <button id="singlePlayerReset" class="single-player-danger" type="button">RESET LOCAL CHARACTER</button>
        </div>
      </section>`;
    document.body.appendChild(overlay);

    $('singlePlayerClose').onclick = () => overlay.classList.add('hidden');
    overlay.addEventListener('click', event => { if (event.target === overlay) overlay.classList.add('hidden'); });
    $('singlePlayerRun').onclick = () => run().catch(error => setStatus('Local Play failed:\n' + (error.message || error)));
    $('singlePlayerOpen').onclick = openPreview;
    $('singlePlayerExport').onclick = async () => {
      try {
        await ensureServiceWorker();
        const result = await workerMessage('IRONVALE_LOCAL_EXPORT_STATE');
        downloadJson(SAVE_FILENAME, result.state);
        setStatus('Exported Ironvale local character/backend state as JSON.');
      } catch (error) { setStatus('Export failed:\n' + (error.message || error)); }
    };
    $('singlePlayerImportInput').onchange = async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const state = JSON.parse(await file.text());
        await ensureServiceWorker();
        await workerMessage('IRONVALE_LOCAL_IMPORT_STATE', state);
        setStatus('Imported Ironvale local state. Reload Local Play to use it.');
      } catch (error) { setStatus('Import failed:\n' + (error.message || error)); }
    };
    $('singlePlayerReset').onclick = async () => {
      if (!confirm('Reset the browser-only Ironvale local character state? Workspace files and terrain source are untouched.')) return;
      try {
        await ensureServiceWorker();
        await workerMessage('IRONVALE_LOCAL_RESET_STATE');
        setStatus('Local character reset to the 320, 320 spawn. Workspace files were untouched.');
      } catch (error) { setStatus('Reset failed:\n' + (error.message || error)); }
    };
  }

  function setStatus(text) {
    const node = $('singlePlayerStatus');
    if (node) node.textContent = text;
  }

  async function run() {
    ensureModal();
    if (repo() !== TARGET_REPO) throw new Error(`Select/pull ${TARGET_REPO} first. Current repo: ${repo() || 'none'}.`);
    const button = $('singlePlayerRun');
    button.disabled = true;
    const lines = [];
    const log = line => {
      lines.push(String(line));
      if (lines.length > 28) lines.splice(0, lines.length - 28);
      setStatus(lines.join('\n'));
    };
    try {
      log(`Workspace: ${repo()} (${branch() || 'local'})`);
      log('Reading the current local workspace…');
      const workspace = await collectWorkspace();
      log(`Loaded ${workspace.size} workspace file(s).`);
      const nativeWasm = await compileNativeWorkspace(workspace, log);
      log('Preparing current Ironvale public/ runtime…');
      await populatePreviewCache(workspace, log, nativeWasm);
      await ensureServiceWorker(log);
      log('Backend: browser-emulated auth/session/character API.');
      log('Cloudflare/D1: not contacted. GitHub: no write.');
      log('Opening Ironvale Local Play…');
      setTimeout(openPreview, 80);
    } finally {
      button.disabled = false;
    }
  }

  function openModal() {
    ensureModal();
    setStatus(repo() === TARGET_REPO
      ? `Ready for ${repo()} (${branch() || 'local'}).\nPREPARE & PLAY uses production WASM unless native source actually changed.`
      : `Select/pull ${TARGET_REPO} first.\nCurrent repo: ${repo() || 'none'}.`);
    $('singlePlayerModal').classList.remove('hidden');
  }

  function bind() {
    ensureModal();
    $('singlePlayerBtn')?.addEventListener('click', openModal);
    const api = Object.freeze({ open: openModal, run, openPreview });
    window.IronvaleLocalPlay = api;
    window.RiftCitySinglePlayerTest = api;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();