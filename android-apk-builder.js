/* Three-APK build layer for Universal Android Single Player. */
(() => {
  'use strict';

  const BUILD_BRANCH_PREFIX = 'editor-local-apk-';
  const BUILD_OUTPUTS = Object.freeze({
    arm32: '__editor_build__/Fallpoint-arm32-debug.apk',
    arm64: '__editor_build__/Fallpoint-arm64-debug.apk',
    universal: '__editor_build__/Fallpoint-universal-debug.apk'
  });
  const $ = id => document.getElementById(id);
  const repo = () => $('repoSelect')?.value || '';
  const branch = () => $('branchSelect')?.value || 'main';
  const token = () => $('tokenInput')?.value?.trim() || '';
  const status = text => { if ($('singlePlayerStatus')) $('singlePlayerStatus').textContent = text; };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let lastBuild = null;

  async function templateText() {
    const response = await fetch(new URL('android-local-backend-template.java.txt', location.href), { cache: 'no-store' });
    if (!response.ok) throw new Error('Missing Android local-backend template.');
    return response.text();
  }

  function decodeDataUrl(content) {
    const text = typeof content === 'string' ? content : String(content ?? '');
    const match = text.match(/^data:[^;,]*;base64,([\s\S]+)$/i);
    if (!match) return { binary: false, value: text };
    const raw = atob(match[1].replace(/\s/g, ''));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return { binary: true, value: bytes };
  }

  function parseToolVersions(files) {
    const app = String(files.get('app/build.gradle') || files.get('app/build.gradle.kts') || '');
    return {
      compileSdk: app.match(/\bcompileSdk\s*(?:=\s*)?(\d+)/)?.[1] || '36',
      ndk: app.match(/\bndkVersion\s*(?:=\s*)?["']([^"']+)["']/)?.[1] || '28.2.13676358',
      cmake: app.match(/\bversion\s*(?:=\s*)?["'](3\.[^"']+)["']/)?.[1] || '3.22.1'
    };
  }

  function workflowText(files) {
    const v = parseToolVersions(files);
    return `name: Editor Local APK\n\non:\n  push:\n\npermissions:\n  contents: write\n\njobs:\n  build:\n    if: \${{ !contains(github.event.head_commit.message, '[editor-apk]') }}\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: '17'\n      - uses: gradle/actions/setup-gradle@v4\n        with:\n          gradle-version: '9.6.0'\n      - uses: android-actions/setup-android@v3\n      - name: Install Android toolchain\n        run: |\n          yes | sdkmanager --licenses >/dev/null || true\n          sdkmanager \"platforms;android-${v.compileSdk}\" \"build-tools;${v.compileSdk}.0.0\" \"ndk;${v.ndk}\" \"cmake;${v.cmake}\"\n      - name: Build universal debug APK\n        run: gradle :app:assembleDebug --stacktrace\n      - name: Verify universal source APK\n        run: |\n          APK=app/build/outputs/apk/debug/app-debug.apk\n          test -f \"$APK\"\n          unzip -Z1 \"$APK\" | grep -q '^lib/armeabi-v7a/'\n          unzip -Z1 \"$APK\" | grep -q '^lib/arm64-v8a/'\n          if unzip -Z1 \"$APK\" | grep -Eq '^lib/(x86|x86_64)/'; then echo \"Unexpected x86 ABI in universal APK\"; exit 1; fi\n          if [ -f scripts/verify_universal_apk.py ]; then python3 scripts/verify_universal_apk.py \"$APK\"; fi\n      - name: Produce ARM32 ARM64 and universal APKs\n        run: |\n          set -euo pipefail\n          SRC=app/build/outputs/apk/debug/app-debug.apk\n          OUT=__editor_build__\n          mkdir -p \"$OUT\" /tmp/editor-apk-split\n          cp \"$SRC\" \"$OUT/Fallpoint-universal-debug.apk\"\n\n          BT=\"$(ls -d \"$ANDROID_HOME\"/build-tools/* | sort -V | tail -1)\"\n          KEYSTORE=\"$HOME/.android/debug.keystore\"\n          if [ ! -f \"$KEYSTORE\" ]; then\n            mkdir -p \"$(dirname \"$KEYSTORE\")\"\n            keytool -genkeypair -v -keystore \"$KEYSTORE\" -storepass android -alias androiddebugkey -keypass android -dname \"CN=Android Debug,O=Android,C=US\" -keyalg RSA -keysize 2048 -validity 10000\n          fi\n\n          cp \"$SRC\" /tmp/editor-apk-split/arm32-raw.apk\n          zip -q -d /tmp/editor-apk-split/arm32-raw.apk 'lib/arm64-v8a/*' 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.DSA' 'META-INF/*.EC' || true\n          if \"$BT/zipalign\" -h 2>&1 | grep -q -- '-P'; then\n            \"$BT/zipalign\" -f -P 16 4 /tmp/editor-apk-split/arm32-raw.apk /tmp/editor-apk-split/arm32-aligned.apk\n          else\n            \"$BT/zipalign\" -f 4 /tmp/editor-apk-split/arm32-raw.apk /tmp/editor-apk-split/arm32-aligned.apk\n          fi\n          \"$BT/apksigner\" sign --ks \"$KEYSTORE\" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out \"$OUT/Fallpoint-arm32-debug.apk\" /tmp/editor-apk-split/arm32-aligned.apk\n\n          cp \"$SRC\" /tmp/editor-apk-split/arm64-raw.apk\n          zip -q -d /tmp/editor-apk-split/arm64-raw.apk 'lib/armeabi-v7a/*' 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.DSA' 'META-INF/*.EC' || true\n          if \"$BT/zipalign\" -h 2>&1 | grep -q -- '-P'; then\n            \"$BT/zipalign\" -f -P 16 4 /tmp/editor-apk-split/arm64-raw.apk /tmp/editor-apk-split/arm64-aligned.apk\n          else\n            \"$BT/zipalign\" -f 4 /tmp/editor-apk-split/arm64-raw.apk /tmp/editor-apk-split/arm64-aligned.apk\n          fi\n          \"$BT/apksigner\" sign --ks \"$KEYSTORE\" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out \"$OUT/Fallpoint-arm64-debug.apk\" /tmp/editor-apk-split/arm64-aligned.apk\n\n          \"$BT/apksigner\" verify --verbose \"$OUT/Fallpoint-universal-debug.apk\"\n          \"$BT/apksigner\" verify --verbose \"$OUT/Fallpoint-arm32-debug.apk\"\n          \"$BT/apksigner\" verify --verbose \"$OUT/Fallpoint-arm64-debug.apk\"\n\n          unzip -Z1 \"$OUT/Fallpoint-universal-debug.apk\" | grep -q '^lib/armeabi-v7a/'\n          unzip -Z1 \"$OUT/Fallpoint-universal-debug.apk\" | grep -q '^lib/arm64-v8a/'\n\n          unzip -Z1 \"$OUT/Fallpoint-arm32-debug.apk\" | grep -q '^lib/armeabi-v7a/'\n          if unzip -Z1 \"$OUT/Fallpoint-arm32-debug.apk\" | grep -q '^lib/arm64-v8a/'; then echo \"ARM32 APK still contains ARM64\"; exit 1; fi\n\n          unzip -Z1 \"$OUT/Fallpoint-arm64-debug.apk\" | grep -q '^lib/arm64-v8a/'\n          if unzip -Z1 \"$OUT/Fallpoint-arm64-debug.apk\" | grep -q '^lib/armeabi-v7a/'; then echo \"ARM64 APK still contains ARM32\"; exit 1; fi\n\n          echo \"PASS: generated ARM32, ARM64 and universal APKs\"\n      - name: Publish three APKs to temporary build branch\n        run: |\n          git config user.name \"Editor APK Builder\"\n          git config user.email \"editor-apk-builder@users.noreply.github.com\"\n          git add -f __editor_build__/Fallpoint-arm32-debug.apk __editor_build__/Fallpoint-arm64-debug.apk __editor_build__/Fallpoint-universal-debug.apk\n          git commit -m \"[editor-apk] ARM32 ARM64 universal debug APKs\"\n          git push origin HEAD:\${{ github.ref_name }}\n`;
  }

  async function gh(path, options = {}) {
    const r = repo(), t = token();
    if (!r || !r.includes('/')) throw new Error('Select a GitHub repository first.');
    if (!t) throw new Error('Connect your GitHub token first. APK builds need temporary-branch write access.');
    const response = await fetch(`https://api.github.com/repos/${r}${path}`, {
      ...options,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${t}`, 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) }
    });
    if (response.status === 204) return null;
    let data = null; try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data?.message || `GitHub API ${response.status}`);
    return data;
  }

  function b64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  async function createBlob(content) {
    const item = decodeDataUrl(content);
    const body = item.binary ? { content: b64(item.value), encoding: 'base64' } : { content: item.value, encoding: 'utf-8' };
    return (await gh('/git/blobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).sha;
  }

  async function mapLimit(entries, limit, worker) {
    const results = new Array(entries.length); let next = 0;
    async function lane() { while (true) { const i = next++; if (i >= entries.length) return; results[i] = await worker(entries[i]); } }
    await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, lane));
    return results;
  }

  async function pushTemporaryBuild(files, buildBranch, log) {
    const base = await gh(`/git/ref/heads/${encodeURIComponent(branch())}`);
    const baseSha = base.object.sha;
    const baseCommit = await gh(`/git/commits/${baseSha}`);
    try { await gh(`/git/refs/heads/${encodeURIComponent(buildBranch)}`, { method: 'DELETE' }); } catch {}
    await gh('/git/refs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: `refs/heads/${buildBranch}`, sha: baseSha }) });
    const entries = [...files.entries()];
    log(`Uploading ${entries.length} files to temporary build branch…`);
    const tree = await mapLimit(entries, 6, async ([path, content]) => ({ path, mode: '100644', type: 'blob', sha: await createBlob(content) }));
    const treeObj = await gh('/git/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }) });
    const commit = await gh('/git/commits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Editor local three-APK build', tree: treeObj.sha, parents: [baseSha] }) });
    await gh(`/git/refs/heads/${encodeURIComponent(buildBranch)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: commit.sha, force: true }) });
    return commit.sha;
  }

  async function waitForApks(buildBranch, log) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await sleep(attempt < 8 ? 3000 : 6000);
      try {
        const pairs = await Promise.all(Object.entries(BUILD_OUTPUTS).map(async ([key, path]) => {
          const item = await gh(`/contents/${path}?ref=${encodeURIComponent(buildBranch)}`);
          return [key, item];
        }));
        if (pairs.every(([, item]) => item?.sha)) return Object.fromEntries(pairs);
      } catch {}
      if (attempt % 3 === 0) {
        const runs = await gh(`/actions/runs?branch=${encodeURIComponent(buildBranch)}&event=push&per_page=5`).catch(() => null);
        const run = runs?.workflow_runs?.find(x => x.name === 'Editor Local APK');
        if (run) {
          log(`Build: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`);
          if (run.status === 'completed' && run.conclusion !== 'success') throw new Error(`APK build failed (${run.conclusion}). Check the Actions run for the compiler or packaging error.`);
        }
      }
    }
    throw new Error('Timed out waiting for the three APK builds.');
  }

  async function downloadBlob(sha) {
    const blob = await gh(`/git/blobs/${sha}`);
    if (blob.encoding !== 'base64' || !blob.content) throw new Error('GitHub returned an unsupported APK blob encoding.');
    const raw = atob(blob.content.replace(/\s/g, ''));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: 'application/vnd.android.package-archive' });
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function ensureDownloadPanel() {
    const modal = $('singlePlayerModal');
    if (!modal) return null;
    let panel = $('singlePlayerApkDownloads');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'singlePlayerApkDownloads';
    panel.className = 'single-player-actions';
    panel.style.display = 'none';
    panel.innerHTML = `
      <button id="downloadArm32Apk" class="single-player-secondary" type="button">DOWNLOAD ARM32 APK</button>
      <button id="downloadArm64Apk" class="single-player-secondary" type="button">DOWNLOAD ARM64 APK</button>
      <button id="downloadUniversalApk" class="single-player-secondary" type="button">DOWNLOAD UNIVERSAL APK</button>
      <button id="downloadAllApks" class="single-player-run" type="button">DOWNLOAD ALL 3</button>`;
    const actions = modal.querySelector('.single-player-actions');
    actions?.after(panel);
    $('downloadArm32Apk').onclick = () => downloadLast('arm32');
    $('downloadArm64Apk').onclick = () => downloadLast('arm64');
    $('downloadUniversalApk').onclick = () => downloadLast('universal');
    $('downloadAllApks').onclick = () => {
      downloadLast('arm32');
      setTimeout(() => downloadLast('arm64'), 180);
      setTimeout(() => downloadLast('universal'), 360);
    };
    return panel;
  }

  function downloadLast(kind) {
    const item = lastBuild?.[kind];
    if (!item) throw new Error('Build the APKs first.');
    download(item.name, item.blob);
  }

  async function buildApks() {
    const button = $('singlePlayerRun'); if (button) button.disabled = true;
    const panel = ensureDownloadPanel(); if (panel) panel.style.display = 'none';
    lastBuild = null;
    const lines = []; const log = line => { lines.push(String(line)); status(lines.slice(-36).join('\n')); };
    let buildBranch = '';
    try {
      const api = window.FallpointAndroidLocalTest;
      if (!api?.validate || !api?.loadState) throw new Error('Universal Android Single Player is not ready.');
      const { files, info } = await api.validate(log);
      const state = await api.loadState();
      const template = await templateText();
      const snapshot = new Map(files);
      const javaPath = info.namespace.replace(/\./g, '/');
      snapshot.set('app/src/debug/assets/fallpoint-local-backend.json', JSON.stringify(state, null, 2) + '\n');
      snapshot.set(`app/src/debug/java/${javaPath}/local/LocalBackendStore.java`, template.replaceAll('__PACKAGE__', info.namespace));
      snapshot.set('.fallpoint-local-test/state.json', JSON.stringify(state, null, 2) + '\n');
      snapshot.set('.github/workflows/editor-local-apk.yml', workflowText(snapshot));
      buildBranch = `${BUILD_BRANCH_PREFIX}${Date.now()}`;
      log('Production backend: OFF');
      log('Building ARM32 + ARM64 + universal APKs…');
      const commit = await pushTemporaryBuild(snapshot, buildBranch, log);
      log(`Build source: ${commit.slice(0, 8)}`);
      const items = await waitForApks(buildBranch, log);
      log('All three APKs built, aligned, signed and ABI-verified.');
      const [arm32, arm64, universal] = await Promise.all([
        downloadBlob(items.arm32.sha),
        downloadBlob(items.arm64.sha),
        downloadBlob(items.universal.sha)
      ]);
      const safe = (repo().split('/').pop() || 'Fallpoint').replace(/[^a-z0-9._-]+/gi, '-');
      lastBuild = {
        arm32: { name: `${safe}-arm32-debug.apk`, blob: arm32 },
        arm64: { name: `${safe}-arm64-debug.apk`, blob: arm64 },
        universal: { name: `${safe}-universal-debug.apk`, blob: universal }
      };
      if (panel) panel.style.display = 'flex';
      log('READY: 3 APKs');
      log('ARM32 = armeabi-v7a only');
      log('ARM64 = arm64-v8a only');
      log('Universal = ARM32 + ARM64');
      log('Use the download buttons below.');
    } finally {
      if (buildBranch) try { await gh(`/git/refs/heads/${encodeURIComponent(buildBranch)}`, { method: 'DELETE' }); } catch {}
      if (button) button.disabled = false;
    }
  }

  function patchUi() {
    const api = window.FallpointAndroidLocalTest;
    const button = $('singlePlayerRun');
    const modal = $('singlePlayerModal');
    if (!api || !button || !modal) return false;
    button.textContent = 'BUILD 3 APKS';
    button.onclick = () => buildApks().catch(error => status('APK build failed:\n' + (error.message || error)));
    ensureDownloadPanel();
    const note = modal.querySelector('.single-player-note');
    if (note) note.innerHTML = '<b>Three real APK test builds.</b> The Editor builds one verified universal APK, derives aligned/signed ARM32-only and ARM64-only APKs from the exact same binary, then gives you separate download buttons for all three. The temporary build branch is deleted and your selected game branch is not modified.';
    const sub = modal.querySelector('.single-player-head p');
    if (sub) sub.textContent = 'ARM32-only + ARM64-only + universal Android debug APKs.';
    window.FallpointAndroidApkBuilder = Object.freeze({ build: buildApks, download: downloadLast });
    return true;
  }

  function boot() {
    let tries = 0;
    const tick = () => { if (patchUi() || tries++ > 100) return; setTimeout(tick, 50); };
    tick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
