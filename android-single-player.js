/* Universal Android Single Player for Mobile Workspace Editor. */
(() => {
  'use strict';

  const STATE_CACHE = 'fallpoint-android-local-state-v1';
  const REQUIRED_ABIS = ['armeabi-v7a', 'arm64-v8a'];
  const OMIT_PREFIXES = ['.git/', '.gradle/', 'build/', 'app/build/', 'node_modules/'];
  const OMIT_FILES = new Set(['local.properties']);
  const MAX_FILES = 12000;
  const MAX_BYTES = 256 * 1024 * 1024;
  const $ = id => document.getElementById(id);
  const repo = () => $('repoSelect')?.value || 'local-workspace';
  const branch = () => $('branchSelect')?.value || 'local';

  async function saveDirtyEditor() {
    const editor = $('editor');
    const path = editor?.dataset?.filename || '';
    if (!path || typeof saveFileToDb !== 'function') return;
    if (typeof isDirty !== 'undefined' && !isDirty) return;
    await saveFileToDb(path, editor.value);
    if (typeof updateDirtyIndicator === 'function') updateDirtyIndicator(false);
  }

  function normalizePath(value) {
    const out = [];
    for (const part of String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return out.join('/');
  }

  function secret(path) {
    const base = normalizePath(path).split('/').pop() || '';
    return /^(?:\.env)(?:\..*)?$/i.test(base)
      || /^(?:\.npmrc|\.pypirc|id_rsa|id_ed25519)$/i.test(base)
      || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(base);
  }

  function omit(path) {
    const p = normalizePath(path);
    return !p || OMIT_FILES.has(p) || secret(p) || OMIT_PREFIXES.some(prefix => p.startsWith(prefix));
  }

  function asBytesIfDataUrl(content) {
    const text = typeof content === 'string' ? content : String(content ?? '');
    const match = text.match(/^data:[^;,]*;base64,([\s\S]+)$/i);
    if (!match) return text;
    const raw = atob(match[1].replace(/\s/g, ''));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function sizeOf(content) {
    const value = asBytesIfDataUrl(content);
    return typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength;
  }

  async function workspace() {
    if (typeof getAllWorkspaceFiles !== 'function') throw new Error('Workspace read API is unavailable.');
    await saveDirtyEditor();
    const raw = await getAllWorkspaceFiles();
    if (raw.length > MAX_FILES) throw new Error(`Workspace exceeds ${MAX_FILES} files.`);
    const files = new Map();
    let bytes = 0;
    for (const file of raw) {
      const path = normalizePath(file?.name || '');
      if (omit(path)) continue;
      const content = typeof file.content === 'string' ? file.content : String(file.content ?? '');
      bytes += sizeOf(content);
      if (bytes > MAX_BYTES) throw new Error('Workspace exceeds the 256 MiB local-package safety limit.');
      files.set(path, content);
    }
    return { files, bytes };
  }

  function first(files, names) {
    for (const name of names) if (files.has(name)) return { path: name, content: files.get(name) };
    return null;
  }

  function namespaceOf(files) {
    const gradle = String(first(files, ['app/build.gradle', 'app/build.gradle.kts'])?.content || '');
    const match = gradle.match(/\bnamespace\s*(?:=\s*)?["']([^"']+)["']/);
    if (match) return match[1];
    const manifest = String(files.get('app/src/main/AndroidManifest.xml') || '');
    return manifest.match(/\bpackage\s*=\s*["']([^"']+)["']/)?.[1] || 'com.fallpoint.game';
  }

  function validate(files) {
    const errors = [], warnings = [];
    const settings = first(files, ['settings.gradle', 'settings.gradle.kts']);
    const appGradle = first(files, ['app/build.gradle', 'app/build.gradle.kts']);
    const manifest = files.get('app/src/main/AndroidManifest.xml');
    const cmake = files.get('app/src/main/cpp/CMakeLists.txt');
    if (!settings) errors.push('Missing settings.gradle/settings.gradle.kts.');
    if (!appGradle) errors.push('Missing app/build.gradle/app/build.gradle.kts.');
    if (!manifest) errors.push('Missing app/src/main/AndroidManifest.xml.');
    if (!cmake) errors.push('Missing app/src/main/cpp/CMakeLists.txt.');
    const gradleText = String(appGradle?.content || '');
    for (const abi of REQUIRED_ABIS) if (!gradleText.includes(abi)) errors.push(`Missing required ABI: ${abi}`);
    if (appGradle && !/externalNativeBuild|cmake/i.test(gradleText)) warnings.push('No obvious externalNativeBuild/CMake wiring found.');
    if (cmake && !/add_library\s*\([^)]*SHARED/is.test(String(cmake))) warnings.push('CMake does not obviously declare a SHARED library.');
    return { ok: !errors.length, errors, warnings, namespace: namespaceOf(files) };
  }

  function stateUrl() {
    const scope = new URL('./', location.href).pathname;
    return location.origin + scope + '__fallpoint_android_state__/' + encodeURIComponent(`${repo()}::${branch()}`) + '.json';
  }

  function freshState() {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      mode: 'single-player',
      backend: 'device-local',
      player: { id: 'local-player', displayName: 'LocalTester' },
      character: { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
      stash: { items: [] },
      raid: { active: false },
      createdAt: now,
      updatedAt: now
    };
  }

  function normalizedState(value) {
    const base = freshState();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
    const out = {
      ...base, ...value,
      schemaVersion: 1, mode: 'single-player', backend: 'device-local',
      player: { ...base.player, ...(value.player || {}) },
      character: { ...base.character, ...(value.character || {}) },
      stash: { ...base.stash, ...(value.stash || {}) },
      raid: { ...base.raid, ...(value.raid || {}) },
      updatedAt: new Date().toISOString()
    };
    out.character.position = { ...base.character.position, ...(value.character?.position || {}) };
    return out;
  }

  async function saveState(value) {
    const state = normalizedState(value);
    const cache = await caches.open(STATE_CACHE);
    await cache.put(stateUrl(), new Response(JSON.stringify(state, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
    return state;
  }

  async function loadState() {
    const cache = await caches.open(STATE_CACHE);
    const response = await cache.match(stateUrl());
    if (!response) return saveState(freshState());
    try { return normalizedState(await response.json()); }
    catch { return saveState(freshState()); }
  }

  async function templateText(name) {
    const response = await fetch(new URL(name, location.href), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Missing Editor template: ${name}`);
    return response.text();
  }

  function buildScript() {
    return `#!/usr/bin/env sh\nset -eu\nROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\"\ncd \"$ROOT\"\nif [ -x ./gradlew ]; then G=./gradlew; elif command -v gradle >/dev/null 2>&1; then G=gradle; else echo \"FAIL: Gradle not found.\" >&2; exit 2; fi\n\"$G\" :app:assembleDebug\nAPK=\"$ROOT/app/build/outputs/apk/debug/app-debug.apk\"\n[ -f \"$APK\" ] || { echo \"FAIL: APK not found: $APK\" >&2; exit 2; }\nif command -v python3 >/dev/null 2>&1 && [ -f \"$ROOT/scripts/verify_universal_apk.py\" ]; then python3 \"$ROOT/scripts/verify_universal_apk.py\" \"$APK\"; fi\necho \"PASS: $APK\"\n`;
  }

  async function makeZip(files, info, state, log) {
    if (typeof JSZip !== 'function') throw new Error('JSZip is unavailable. Reload the Editor while online once.');
    const zip = new JSZip();
    for (const [path, content] of files) zip.file(path, asBytesIfDataUrl(content));
    const template = (await templateText('android-local-backend-template.java.txt')).replaceAll('__PACKAGE__', info.namespace);
    const javaPath = info.namespace.replace(/\./g, '/');
    const meta = {
      format: 'fallpoint-android-local-test-v1',
      generatedAt: new Date().toISOString(),
      source: { repo: repo(), branch: branch() },
      android: { namespace: info.namespace, requiredAbis: REQUIRED_ABIS },
      localBackend: { mode: 'single-player', seedAsset: 'app/src/debug/assets/fallpoint-local-backend.json' }
    };
    zip.file('.fallpoint-local-test/manifest.json', JSON.stringify(meta, null, 2) + '\n');
    zip.file('.fallpoint-local-test/state.json', JSON.stringify(state, null, 2) + '\n');
    zip.file('app/src/debug/assets/fallpoint-local-backend.json', JSON.stringify(state, null, 2) + '\n');
    zip.file(`app/src/debug/java/${javaPath}/local/LocalBackendStore.java`, template);
    zip.file('tools/build-local-android.sh', buildScript(), { unixPermissions: '755' });
    log('Added debug-only device-local backend seed/store.');
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function status(text) { if ($('singlePlayerStatus')) $('singlePlayerStatus').textContent = text; }

  function modal() {
    if ($('singlePlayerModal')) return;
    const style = document.createElement('style');
    style.textContent = `.single-player-overlay{position:fixed;inset:0;z-index:211000;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(2,6,12,.82)}.single-player-overlay.hidden{display:none}.single-player-card{width:min(720px,100%);max-height:92dvh;overflow:auto;background:#10161f;color:#edf4fb;border:1px solid #335044;border-radius:16px;padding:16px;box-sizing:border-box}.single-player-head{display:flex;justify-content:space-between;gap:10px}.single-player-head h2{margin:0;font-size:18px}.single-player-head p{margin:4px 0 0;color:#9eb8aa;font-size:12px}.single-player-close{width:38px;height:38px;border:1px solid #435c50;border-radius:9px;background:#18271f;color:white}.single-player-note{margin:12px 0;padding:10px;border:1px solid #2d6140;border-radius:10px;background:#0b2415;font-size:12px;line-height:1.5}.single-player-status{min-height:110px;padding:10px;border:1px solid #2d4737;border-radius:10px;background:#090f0b;white-space:pre-wrap;font:12px/1.45 ui-monospace,monospace}.single-player-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.single-player-actions button,.single-player-actions label{flex:1 1 150px;border:0;border-radius:10px;padding:11px 12px;font-weight:800;text-align:center;box-sizing:border-box;cursor:pointer}.single-player-run{background:#22c55e;color:#07150b}.single-player-secondary{background:#283b31;color:#e9f8ef}.single-player-danger{background:#63252b;color:#ffd8dc}`;
    document.head.appendChild(style);
    const overlay = document.createElement('div');
    overlay.id = 'singlePlayerModal'; overlay.className = 'single-player-overlay hidden';
    overlay.innerHTML = `<section class="single-player-card"><div class="single-player-head"><div><h2>🎮 Universal Android Single Player</h2><p>ARM32 + ARM64 local debug packaging.</p></div><button id="singlePlayerClose" class="single-player-close">×</button></div><div class="single-player-note"><b>Local-only.</b> Validates the current Gradle/NDK project, keeps a device-local test state, and exports a root-level Android project ZIP with a debug-only local backend seed. Production backend is never contacted.</div><div id="singlePlayerStatus" class="single-player-status">Ready.</div><div class="single-player-actions"><button id="singlePlayerRun" class="single-player-run">PREPARE LOCAL ANDROID ZIP</button><button id="singlePlayerValidate" class="single-player-secondary">VALIDATE UNIVERSAL BUILD</button><button id="singlePlayerExport" class="single-player-secondary">EXPORT LOCAL STATE</button><label class="single-player-secondary">IMPORT LOCAL STATE<input id="singlePlayerImport" type="file" accept=".json,application/json" hidden></label><button id="singlePlayerReset" class="single-player-danger">RESET LOCAL STATE</button></div></section>`;
    document.body.appendChild(overlay);
    $('singlePlayerClose').onclick = () => overlay.classList.add('hidden');
    overlay.onclick = event => { if (event.target === overlay) overlay.classList.add('hidden'); };
    $('singlePlayerRun').onclick = () => prepare().catch(error => status('Package failed:\n' + (error.message || error)));
    $('singlePlayerValidate').onclick = () => inspect().catch(error => status('Validation failed:\n' + (error.message || error)));
    $('singlePlayerExport').onclick = async () => download('fallpoint-local-state.json', new Blob([JSON.stringify(await loadState(), null, 2) + '\n'], { type: 'application/json' }));
    $('singlePlayerImport').onchange = async event => { const f = event.target.files?.[0]; event.target.value = ''; if (!f) return; try { await saveState(JSON.parse(await f.text())); status('Local state imported.'); } catch (e) { status('Import failed:\n' + (e.message || e)); } };
    $('singlePlayerReset').onclick = async () => { if (confirm('Reset this workspace\'s local single-player state?')) { await saveState(freshState()); status('Local state reset.'); } };
  }

  async function inspect(logExternal) {
    modal(); const lines = []; const log = line => { lines.push(String(line)); status(lines.slice(-30).join('\n')); logExternal?.(line); };
    log(`Workspace: ${repo()} (${branch()})`);
    const { files, bytes } = await workspace(); log(`Loaded ${files.size} exportable files (${(bytes / 1048576).toFixed(1)} MiB).`);
    const info = validate(files); for (const w of info.warnings) log('WARN: ' + w);
    if (!info.ok) throw new Error(info.errors.join('\n'));
    log(`Namespace: ${info.namespace}`); log('armeabi-v7a ✓'); log('arm64-v8a ✓'); log('Universal Android contract: PASS');
    return { files, info };
  }

  async function prepare() {
    const button = $('singlePlayerRun'); button.disabled = true; const lines = []; const log = line => { lines.push(String(line)); status(lines.slice(-30).join('\n')); };
    try {
      const { files, info } = await inspect(log); const state = await loadState();
      log('Production backend: OFF'); log('Local backend seed: ready');
      const blob = await makeZip(files, info, state, log);
      const safe = (repo().split('/').pop() || 'android-game').replace(/[^a-z0-9._-]+/gi, '-');
      const name = `${safe}-local-android-test.zip`; download(name, blob); log(`Ready: ${name}`); log('ZIP root = Gradle project root.');
    } finally { button.disabled = false; }
  }

  function open() { modal(); status(`Workspace: ${repo()} (${branch()})\nReady for a Fallpoint-style universal Android project.`); $('singlePlayerModal').classList.remove('hidden'); }
  function bind() { modal(); $('singlePlayerBtn')?.addEventListener('click', open); window.FallpointAndroidLocalTest = Object.freeze({ open, validate: inspect, package: prepare, loadState, saveState }); window.RiftCitySinglePlayerTest = window.FallpointAndroidLocalTest; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true }); else bind();
})();
