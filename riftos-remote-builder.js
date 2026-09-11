/* RiftOS local-controller build path.
   Keeps private RiftOS Actions at zero: the browser syncs source to private RiftOS,
   dispatches public Riftos-builder, then consumes verified private RiftOS prereleases.
*/
(() => {
  'use strict';

  const RIFT_REPO = 'Arctic403/RiftOS';
  const BUILDER_REPO = 'Arctic403/Riftos-builder';
  const BUILDER_WORKFLOW = 'riftos-worker.yml';
  const WORKSPACE_DB = 'MobileWorkspaceDB_SafariSafe_v4';
  const WORKSPACE_STORE = 'files';
  const POLL_MS = 10000;
  const MAX_POLLS = 360;
  const REQUEST_TIMEOUT_MS = 45000;
  const REQUEST_RETRIES = 3;
  const UPLOAD_CONCURRENCY = 3;
  const BUILD_STATE_KEY = 'riftos_remote_build_state_v1';
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  let activeBuild = false;
  let lastSuccess = null;

  const token = () => $('tokenInput')?.value?.trim() || '';
  const selectedRepo = () => $('repoSelect')?.value || '';
  const selectedBranch = () => $('branchSelect')?.value || 'main';
  const isRiftOS = () => selectedRepo().toLowerCase() === RIFT_REPO.toLowerCase();

  function saveBuildState() {
    if (!lastSuccess) return;
    try { localStorage.setItem(BUILD_STATE_KEY, JSON.stringify(lastSuccess)); } catch {}
  }

  function restoreBuildState() {
    try {
      const saved = JSON.parse(localStorage.getItem(BUILD_STATE_KEY) || 'null');
      if (saved?.apk && saved?.verification) {
        lastSuccess = saved;
        return true;
      }
    } catch {}
    return false;
  }

  function headers(extra = {}) {
    const value = token();
    if (!value) throw new Error('Connect a GitHub token first.');
    return {
      Authorization: `Bearer ${value}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra
    };
  }

  async function gh(repo, path, options = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
          ...options,
          headers: headers(options.headers || {}),
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (response.status === 204) return null;
        let data = null;
        try { data = await response.json(); } catch {}
        if (response.ok) return data;
        const message = data?.message || `GitHub API ${response.status}`;
        const transient = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!transient || attempt === REQUEST_RETRIES) throw new Error(message);
        lastError = new Error(message);
      } catch (error) {
        clearTimeout(timeout);
        const normalized = error?.name === 'AbortError'
          ? new Error(`GitHub request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`)
          : error;
        lastError = normalized;
        if (attempt === REQUEST_RETRIES) throw normalized;
      }
      await sleep(700 * attempt);
    }
    throw lastError || new Error('GitHub request failed.');
  }

  function openWorkspaceDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(WORKSPACE_DB);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the Editor workspace database.'));
    });
  }

  async function workspaceFiles() {
    const database = await openWorkspaceDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = database.transaction(WORKSPACE_STORE, 'readonly');
        const req = tx.objectStore(WORKSPACE_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error || new Error('Could not read the local workspace.'));
      });
    } finally {
      try { database.close(); } catch {}
    }
  }

  function base64Bytes(base64) {
    const clean = String(base64 || '').replace(/\s/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function contentBytes(content) {
    if (typeof content === 'string') {
      const match = content.match(/^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/);
      if (match) return base64Bytes(match[1]);
    }
    return new TextEncoder().encode(content == null ? '' : String(content));
  }

  function dataForBlob(content) {
    if (typeof content === 'string') {
      const match = content.match(/^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/);
      if (match) return { content: match[1].replace(/\s/g, ''), encoding: 'base64' };
    }
    return { content: content == null ? '' : String(content), encoding: 'utf-8' };
  }

  async function gitBlobSha(bytes) {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const payload = new Uint8Array(header.length + bytes.length);
    payload.set(header, 0);
    payload.set(bytes, header.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', payload));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function mapLimit(entries, limit, worker) {
    if (!entries.length) return [];
    const out = new Array(entries.length);
    let next = 0;
    async function lane() {
      while (true) {
        const index = next++;
        if (index >= entries.length) return;
        out[index] = await worker(entries[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, lane));
    return out;
  }

  function safeMode(path, content, remoteMode) {
    if (remoteMode === '100755' || remoteMode === '120000') return remoteMode;
    if (/\.sh$/i.test(path) && String(content || '').startsWith('#!')) return '100755';
    return '100644';
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function buildClientId() {
    const bytes = new Uint32Array(2);
    crypto.getRandomValues(bytes);
    return `editor-riftos-${Date.now()}-${bytes[0].toString(16)}${bytes[1].toString(16)}`;
  }

  function logger() {
    const box = $('riftosBuildLog');
    const lines = [];
    return text => {
      lines.push(String(text));
      while (lines.length > 180) lines.shift();
      if (box) {
        box.textContent = lines.join('\n');
        box.scrollTop = box.scrollHeight;
      }
    };
  }

  function setDownloadVisible(id, visible) {
    const element = $(id);
    if (element) element.style.display = visible ? 'inline-flex' : 'none';
  }

  function clearDownloads(force = false) {
    if (force) {
      lastSuccess = null;
      try { localStorage.removeItem(BUILD_STATE_KEY); } catch {}
    }
    setDownloadVisible('riftosDownloadVerification', false);
    setDownloadVisible('riftosDownloadApk', false);
  }

  function restoreDownloads() {
    if (!lastSuccess) return;
    setDownloadVisible('riftosDownloadVerification', Boolean(lastSuccess.verification));
    setDownloadVisible('riftosDownloadApk', Boolean(lastSuccess.apk));
  }

  function ensureUi() {
    const toolbar = $('appToolbar');
    if (!toolbar) return null;
    let button = $('riftosRemoteBuildBtn');
    if (!button) {
      button = document.createElement('button');
      button.id = 'riftosRemoteBuildBtn';
      button.className = 'btn btn-success';
      button.type = 'button';
      button.textContent = '🛠 Rift Build';
      button.style.display = 'none';
      const push = $('pushAllGitHubBtn');
      if (push) toolbar.insertBefore(button, push);
      else toolbar.appendChild(button);
      button.addEventListener('click', () => runBuild().catch(showFatal));
    }

    let modal = $('riftosBuildModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'riftosBuildModal';
      modal.className = 'modal-overlay hidden';
      modal.innerHTML = `
        <div class="modal-content" style="max-width:760px">
          <div class="modal-header">
            <h3>RiftOS → Riftos-builder</h3>
            <span class="modal-close" id="riftosBuildClose">✕</span>
          </div>
          <p style="font-size:.82rem;color:#aeb7c6;margin-top:0">Local workspace → private RiftOS source commit → public Riftos-builder → verified private RiftOS prerelease. RiftOS itself runs zero Actions.</p>
          <pre id="riftosBuildLog" style="white-space:pre-wrap;max-height:48vh;overflow:auto;background:#0d1117;padding:12px;border-radius:8px;font-size:.78rem"></pre>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
            <button class="btn btn-success" style="display:none" id="riftosDownloadApk" type="button">⬇️ Android APK</button>
            <button class="btn btn-secondary" style="display:none" id="riftosDownloadVerification" type="button">⬇️ Verification ZIP</button>
            <button class="btn btn-secondary" id="riftosBuildCloseBtn" type="button">Close</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const close = () => { if (!activeBuild) modal.classList.add('hidden'); };
      $('riftosBuildClose').onclick = close;
      $('riftosBuildCloseBtn').onclick = close;
      $('riftosDownloadApk').onclick = () => lastSuccess?.apk && downloadReleaseAsset(lastSuccess.apk);
      $('riftosDownloadVerification').onclick = () => lastSuccess?.verification && downloadReleaseAsset(lastSuccess.verification);
    }
    return button;
  }

  function updateVisibility() {
    const button = ensureUi();
    if (button) button.style.display = isRiftOS() ? '' : 'none';
  }

  function showModal() {
    ensureUi();
    $('riftosBuildModal')?.classList.remove('hidden');
  }

  async function pushWorkspace(clientId, log) {
    if (!isRiftOS()) throw new Error(`Select ${RIFT_REPO} first.`);
    const branch = selectedBranch();
    if (!branch) throw new Error('Choose the RiftOS branch to update.');

    if (typeof window.saveCurrentFile === 'function') {
      try { window.saveCurrentFile(false); } catch {}
      await sleep(150);
    }

    const allFiles = await workspaceFiles();
    const files = allFiles
      .filter(file => file?.name && !String(file.name).startsWith('.github/workflows/'))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!files.length) throw new Error('The local workspace is empty. Pull RiftOS into the Editor first.');

    log(`Reading ${files.length} local source files…`);
    const ref = await gh(RIFT_REPO, `/git/ref/heads/${encodeURIComponent(branch)}`);
    const baseSha = ref?.object?.sha;
    if (!baseSha) throw new Error(`Could not resolve RiftOS branch ${branch}.`);
    const baseCommit = await gh(RIFT_REPO, `/git/commits/${baseSha}`);
    const baseTree = baseCommit?.tree?.sha;
    if (!baseTree) throw new Error('Could not resolve the current RiftOS tree.');
    const remote = await gh(RIFT_REPO, `/git/trees/${baseTree}?recursive=1`);
    if (remote?.truncated) throw new Error('RiftOS tree response was truncated; refusing a partial source push.');

    const remoteBlobs = (remote?.tree || []).filter(item => item.type === 'blob');
    const remoteNonWorkflow = remoteBlobs.filter(item => !item.path.startsWith('.github/workflows/'));
    if (remoteNonWorkflow.length >= 20 && files.length < Math.floor(remoteNonWorkflow.length * 0.70)) {
      throw new Error(`Local workspace looks incomplete (${files.length} files versus ${remoteNonWorkflow.length} in RiftOS). Pull the full repo first so a build cannot accidentally delete most of the source tree.`);
    }

    const remoteByPath = new Map(remoteBlobs.map(item => [item.path, item]));
    const localPaths = new Set(files.map(file => String(file.name)));
    let prepared = 0;
    let uploaded = 0;
    let reused = 0;

    log('Comparing local files with GitHub; unchanged blobs will not be uploaded…');
    const preparedEdits = await mapLimit(files, UPLOAD_CONCURRENCY, async file => {
      const path = String(file.name);
      const remoteItem = remoteByPath.get(path);
      const mode = safeMode(path, file.content, remoteItem?.mode);
      const bytes = contentBytes(file.content);
      const localSha = await gitBlobSha(bytes);
      prepared += 1;
      if (remoteItem?.sha === localSha && remoteItem?.mode === mode) {
        reused += 1;
        if (prepared % 25 === 0 || prepared === files.length) log(`Compared ${prepared}/${files.length} · ${reused} unchanged · ${uploaded} uploaded`);
        return null;
      }
      log(`Uploading change: ${path} (${formatBytes(bytes.length)})`);
      const blob = await gh(RIFT_REPO, '/git/blobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dataForBlob(file.content))
      });
      uploaded += 1;
      if (prepared % 25 === 0 || prepared === files.length) log(`Compared ${prepared}/${files.length} · ${reused} unchanged · ${uploaded} uploaded`);
      return { path, mode, type: 'blob', sha: blob.sha };
    });

    const tree = preparedEdits.filter(Boolean);
    let deletions = 0;
    for (const item of remoteBlobs) {
      if (item.path.startsWith('.github/workflows/') || !localPaths.has(item.path)) {
        tree.push({ path: item.path, mode: item.mode || '100644', type: 'blob', sha: null });
        deletions += 1;
      }
    }

    log(`Source diff ready: ${uploaded} upload(s), ${deletions} deletion(s), ${reused} unchanged.`);
    if (!tree.length) {
      log(`Workspace already matches private RiftOS ${baseSha.slice(0, 12)}.`);
      log('RiftOS Actions triggered: 0');
      return baseSha;
    }

    const nextTree = await gh(RIFT_REPO, '/git/trees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTree, tree })
    });
    const commit = await gh(RIFT_REPO, '/git/commits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Editor source snapshot for Riftos-builder (${clientId})`,
        tree: nextTree.sha,
        parents: [baseSha]
      })
    });
    await gh(RIFT_REPO, `/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: commit.sha, force: false })
    });
    log(`Private source pushed: ${commit.sha.slice(0, 12)}`);
    log('RiftOS Actions triggered: 0');
    return commit.sha;
  }

  async function dispatchBuilder(sourceSha, clientId, log) {
    log('Dispatching Riftos-builder directly from the Editor…');
    await gh(BUILDER_REPO, `/actions/workflows/${BUILDER_WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { source_ref: sourceSha, client_id: clientId, publish: 'true' } })
    });
    log(`Riftos-builder accepted client ${clientId}.`);
  }

  async function waitForPrivateRelease(sourceSha, clientId, log) {
    const sourceMarker = `Source ${sourceSha}.`;
    const clientMarker = `Client ${clientId}.`;
    for (let i = 0; i < MAX_POLLS; i += 1) {
      const releases = await gh(RIFT_REPO, '/releases?per_page=40');
      const release = releases.find(item => {
        const body = String(item?.body || '');
        return Boolean(item?.prerelease) && body.includes(sourceMarker) && body.includes(clientMarker);
      });
      if (release) return release;
      if (i === 0) log('Public worker is building private RiftOS source…');
      if (i > 0 && i % 6 === 0) log(`Still building… ${Math.round(i * POLL_MS / 60000)} min elapsed`);
      await sleep(POLL_MS);
    }
    throw new Error('Timed out waiting for Riftos-builder to return the private release.');
  }

  async function assetBlob(asset) {
    const response = await fetch(asset.url, { headers: headers({ Accept: 'application/octet-stream' }) });
    if (!response.ok) throw new Error(`Could not download ${asset.name} (HTTP ${response.status}).`);
    return response.blob();
  }

  async function downloadReleaseAsset(asset) {
    if (!asset) throw new Error('Requested build asset is unavailable.');
    const blob = await assetBlob(asset);
    if (window.showSaveFilePicker) {
      const isApk = asset.name.toLowerCase().endsWith('.apk');
      const handle = await window.showSaveFilePicker({
        suggestedName: asset.name,
        types: [{
          description: isApk ? 'Android APK' : 'Verification archive',
          accept: isApk ? { 'application/vnd.android.package-archive': ['.apk'] } : { 'application/zip': ['.zip'] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = asset.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function handleRelease(release, sourceSha, log) {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const failed = String(release.tag_name || '').startsWith('rift-worker-failed-') || /FAILED/i.test(String(release.name || ''));
    if (failed) {
      const diagnostics = assets.find(asset => /^RiftOS-worker-failure-.*\.zip$/i.test(asset.name));
      if (diagnostics) {
        lastSuccess = { release, verification: diagnostics, apk: null, status: 'failed', sourceSha };
        saveBuildState();
        setDownloadVisible('riftosDownloadVerification', true);
      }
      throw new Error(`Riftos-builder failed for ${sourceSha.slice(0, 12)}. Private diagnostics are attached to the RiftOS prerelease.`);
    }

    const verification = assets.find(asset => /^RiftOS-verification-.*\.zip$/i.test(asset.name));
    const apk = assets.find(asset => /^RiftOS-Android-debug\.apk$/i.test(asset.name));
    if (!verification || !apk) throw new Error('Worker succeeded but required RiftOS build assets are missing from the private prerelease.');

    lastSuccess = { release, verification, apk, status: 'artifact_ready', sourceSha };
    saveBuildState();
    restoreDownloads();
    log('GREEN: RiftOS build and APK verification passed.');
    log(`Private release: ${release.name || release.tag_name}`);
    log('READY: Android APK and verification ZIP are available.');
  }

  async function checkLatestSuccessfulArtifact() {
    if (!isRiftOS() || !token()) return false;
    try {
      const branch = selectedBranch();
      const ref = await gh(RIFT_REPO, `/git/ref/heads/${encodeURIComponent(branch)}`);
      const sourceSha = ref?.object?.sha;
      if (!sourceSha) return false;
      const releases = await gh(RIFT_REPO, '/releases?per_page=40');
      const release = releases.find(item => Boolean(item?.prerelease) && String(item?.body || '').includes(`Source ${sourceSha}.`) && !/FAILED/i.test(String(item?.name || '')));
      if (!release) return false;
      const assets = release.assets || [];
      const verification = assets.find(asset => /^RiftOS-verification-.*\.zip$/i.test(asset.name));
      const apk = assets.find(asset => /^RiftOS-Android-debug\.apk$/i.test(asset.name));
      if (!verification || !apk) return false;
      lastSuccess = { release, verification, apk, status: 'artifact_ready', sourceSha };
      saveBuildState();
      restoreDownloads();
      return true;
    } catch (error) {
      console.warn('RiftOS artifact lookup skipped:', error);
      return false;
    }
  }

  function hasRecoverableBuild() {
    return Boolean(lastSuccess?.verification && lastSuccess?.apk && lastSuccess?.status === 'artifact_ready');
  }

  async function recoverExistingBuild() {
    if (!hasRecoverableBuild()) return false;
    showModal();
    restoreDownloads();
    const log = logger();
    log(`Existing green RiftOS build found: ${lastSuccess.sourceSha ? lastSuccess.sourceSha.slice(0, 12) : 'unknown'}`);
    log('Artifact recovery mode: no rebuild triggered.');
    return true;
  }

  async function runBuild() {
    if (activeBuild) return;
    if (hasRecoverableBuild() && !confirm('A completed RiftOS build already exists. Rebuild from scratch?\n\nCancel will open artifact recovery instead.')) {
      await recoverExistingBuild();
      return;
    }
    if (!isRiftOS()) return alert(`Select ${RIFT_REPO} first.`);
    if (!token()) return alert('Connect your GitHub token first.');
    const branch = selectedBranch();
    if (!branch) return alert('Choose a RiftOS branch first.');
    if (!confirm(`Sync the COMPLETE local RiftOS workspace to ${branch}, run Riftos-builder, and return the verified APK through a private RiftOS prerelease?\n\nOnly changed source blobs are uploaded. .github/workflows is intentionally removed so private RiftOS runs zero Actions.`)) return;

    activeBuild = true;
    clearDownloads(true);
    showModal();
    const button = $('riftosRemoteBuildBtn');
    if (button) { button.disabled = true; button.textContent = '🛠 Building…'; }
    const log = logger();
    const clientId = buildClientId();
    try {
      log(`Client: ${clientId}`);
      log(`Target: ${RIFT_REPO} ${branch}`);
      const sourceSha = await pushWorkspace(clientId, log);
      await dispatchBuilder(sourceSha, clientId, log);
      const release = await waitForPrivateRelease(sourceSha, clientId, log);
      await handleRelease(release, sourceSha, log);
    } finally {
      activeBuild = false;
      if (button) { button.disabled = false; button.textContent = '🛠 Rift Build'; }
    }
  }

  function showFatal(error) {
    showModal();
    const box = $('riftosBuildLog');
    const message = error?.message || String(error);
    if (box) box.textContent += `${box.textContent ? '\n' : ''}ERROR: ${message}`;
    console.error('RiftOS remote build failed', error);
  }

  function guardDirectWorkflowPushes() {
    const pushOne = $('pushGitHubBtn');
    if (pushOne) {
      pushOne.addEventListener('click', event => {
        if (!isRiftOS()) return;
        const path = $('editor')?.dataset?.filename || '';
        if (!path.startsWith('.github/workflows/')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        alert('RiftOS GitHub Actions are intentionally disabled. Build workflows belong in public Riftos-builder.');
      }, true);
    }
  }

  function boot() {
    restoreBuildState();
    ensureUi();
    restoreDownloads();
    updateVisibility();
    $('repoSelect')?.addEventListener('change', updateVisibility);
    $('repoSelect')?.addEventListener('change', () => checkLatestSuccessfulArtifact());
    guardDirectWorkflowPushes();
    window.addEventListener('pageshow', updateVisibility);
    window.RiftOSRemoteBuilder = Object.freeze({ build: runBuild, recover: recoverExistingBuild, checkArtifact: checkLatestSuccessfulArtifact });
    checkLatestSuccessfulArtifact();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
