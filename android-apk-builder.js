/* Real APK build layer for Universal Android Single Player. */
(() => {
  'use strict';

  const BUILD_BRANCH_PREFIX = 'editor-local-apk-';
  const BUILD_APK_PATH = '__editor_build__/Fallpoint-local-debug.apk';
  const $ = id => document.getElementById(id);
  const repo = () => $('repoSelect')?.value || '';
  const branch = () => $('branchSelect')?.value || 'main';
  const token = () => $('tokenInput')?.value?.trim() || '';
  const status = text => { if ($('singlePlayerStatus')) $('singlePlayerStatus').textContent = text; };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    return `name: Editor Local APK\n\non:\n  push:\n\npermissions:\n  contents: write\n\njobs:\n  build:\n    if: \${{ !contains(github.event.head_commit.message, '[editor-apk]') }}\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: '17'\n      - uses: gradle/actions/setup-gradle@v4\n        with:\n          gradle-version: '9.6.0'\n      - uses: android-actions/setup-android@v3\n      - name: Install Android toolchain\n        run: |\n          yes | sdkmanager --licenses >/dev/null || true\n          sdkmanager \"platforms;android-${v.compileSdk}\" \"build-tools;${v.compileSdk}.0.0\" \"ndk;${v.ndk}\" \"cmake;${v.cmake}\"\n      - name: Build universal debug APK\n        run: gradle :app:assembleDebug --stacktrace\n      - name: Verify ARM32 + ARM64\n        run: |\n          APK=app/build/outputs/apk/debug/app-debug.apk\n          test -f \"$APK\"\n          unzip -l \"$APK\" | grep -q 'lib/armeabi-v7a/'\n          unzip -l \"$APK\" | grep -q 'lib/arm64-v8a/'\n          if [ -f scripts/verify_universal_apk.py ]; then python3 scripts/verify_universal_apk.py \"$APK\"; fi\n      - name: Publish APK to temporary build branch\n        run: |\n          mkdir -p __editor_build__\n          cp app/build/outputs/apk/debug/app-debug.apk ${BUILD_APK_PATH}\n          git config user.name \"Editor APK Builder\"\n          git config user.email \"editor-apk-builder@users.noreply.github.com\"\n          git add -f ${BUILD_APK_PATH}\n          git commit -m \"[editor-apk] universal debug APK\"\n          git push origin HEAD:\${{ github.ref_name }}\n`;
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
    const commit = await gh('/git/commits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Editor local universal APK build', tree: treeObj.sha, parents: [baseSha] }) });
    await gh(`/git/refs/heads/${encodeURIComponent(buildBranch)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: commit.sha, force: true }) });
    return commit.sha;
  }

  async function waitForApk(buildBranch, log) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await sleep(attempt < 8 ? 3000 : 6000);
      try {
        const item = await gh(`/contents/${BUILD_APK_PATH}?ref=${encodeURIComponent(buildBranch)}`);
        if (item?.sha) return item;
      } catch {}
      if (attempt % 3 === 0) {
        const runs = await gh(`/actions/runs?branch=${encodeURIComponent(buildBranch)}&event=push&per_page=5`).catch(() => null);
        const run = runs?.workflow_runs?.find(x => x.name === 'Editor Local APK');
        if (run) {
          log(`Build: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`);
          if (run.status === 'completed' && run.conclusion !== 'success') throw new Error(`APK build failed (${run.conclusion}). Check the Actions run for the compiler error.`);
        }
      }
    }
    throw new Error('Timed out waiting for the APK build.');
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
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  async function buildApk() {
    const button = $('singlePlayerRun'); if (button) button.disabled = true;
    const lines = []; const log = line => { lines.push(String(line)); status(lines.slice(-32).join('\n')); };
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
      log('Starting isolated universal APK build…');
      const commit = await pushTemporaryBuild(snapshot, buildBranch, log);
      log(`Build source: ${commit.slice(0, 8)}`);
      const item = await waitForApk(buildBranch, log);
      log('APK built and ABI-verified. Downloading…');
      const apk = await downloadBlob(item.sha);
      const safe = (repo().split('/').pop() || 'Fallpoint').replace(/[^a-z0-9._-]+/gi, '-');
      download(`${safe}-local-debug.apk`, apk);
      log(`DONE: ${safe}-local-debug.apk`);
      log('Contains armeabi-v7a + arm64-v8a.');
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
    button.textContent = 'BUILD & DOWNLOAD APK';
    button.onclick = () => buildApk().catch(error => status('APK build failed:\n' + (error.message || error)));
    const note = modal.querySelector('.single-player-note');
    if (note) note.innerHTML = '<b>Real APK test build.</b> The current local workspace is copied to an isolated temporary build branch. GitHub Actions runs the Android SDK/NDK compiler, verifies ARM32 + ARM64, the Editor downloads the resulting APK to this phone, then deletes the temporary branch. Your selected game branch is not modified.';
    const sub = modal.querySelector('.single-player-head p');
    if (sub) sub.textContent = 'Build and download a real universal Android debug APK.';
    window.FallpointAndroidApkBuilder = Object.freeze({ build: buildApk });
    return true;
  }

  function boot() {
    let tries = 0;
    const tick = () => { if (patchUi() || tries++ > 100) return; setTimeout(tick, 50); };
    tick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
