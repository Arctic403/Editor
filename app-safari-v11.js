// #region Global Constants & Variables
const EXTENSION_REGEX = /\.(txt|json|js|mjs|cjs|ts|tsx|jsx|css|scss|sass|less|html|htm|md|xml|cfg|ini|lua|py|cpp|c|h|hpp|cs|java|go|rs|php|rb|sh|bat|ps1|sql|yaml|yml|toml|env|gitignore|properties|log|swift|kt|kts|dart|r|m|mm|vue|svelte|astro|graphql|gql|prisma|diff|patch|dockerfile|makefile)$/i;

let db;
let dbReadyPromise = null;
const BUILD_ID = "SafariSafe-v12-Folders-20260820";
const WORKSPACE_DB_NAME = "MobileWorkspaceDB_SafariSafe_v4";
const WORKSPACE_DB_VERSION = 2;
const APP_BUILD = "2026-08-20-folder-manager-v12";
console.info("Mobile Workspace build:", APP_BUILD);
let lastSearchIndex = 0;
let selectedFolderPath = "";
const expandedFolderPaths = new Set();
let lastFolderTapPath = "";
let lastFolderTapTime = 0;
let secondaryPaneFileName = ""; 
let isDirty = false;
let gitSyncBusy = false;
let gitSyncStatusTimer = null;
let gitSyncStatusRunId = 0;
const GIT_SYNC_STATE_KEY = "gh_sync_state_v2";
const workspaceHashCache = new Map();
// #endregion

// #region Helper Utilities
function bindClick(id, handler) {
    const element = document.getElementById(id);
    if (element) {
        element.addEventListener("click", handler);
    }
}

function isTextContent(str) {
    if (!str) return true;
    let nonPrintable = 0;
    for (let i = 0; i < Math.min(str.length, 1000); i++) {
        const code = str.charCodeAt(i);
        if (code < 9 || (code > 13 && code < 32)) {
            nonPrintable++;
        }
    }
    return (nonPrintable / Math.min(str.length, 1000)) < 0.1;
}

function decodeBase64Text(base64Str) {
    try {
        const cleanBase64 = base64Str.replace(/^data:application\/octet-stream;base64,/, "");
        const binaryString = atob(cleanBase64);
        if (isTextContent(binaryString)) {
            return binaryString;
        }
    } catch (e) {}
    return base64Str;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function switchTab(viewName) {
    document.querySelectorAll('.page-view').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

    const targetView = document.getElementById(viewName + 'View');
    const targetTab = document.getElementById('tab' + viewName.charAt(0).toUpperCase() + viewName.slice(1));

    if (targetView) targetView.classList.add('active');
    if (targetTab) targetTab.classList.add('active');

    try {
        window.dispatchEvent(new CustomEvent('workspace:view-changed', { detail: { view: viewName } }));
    } catch (e) {}
}

function applySyntaxHighlighting(code, filename) {
    if (!filename) return escapeHtml(code);
    const ext = filename.split('.').pop().toLowerCase();
    let escaped = escapeHtml(code);

    if (["js", "ts", "jsx", "tsx", "json", "mjs", "cjs"].includes(ext)) {
        return escaped
            .replace(/(&quot;[\s\S]*?&quot;|&#039;[\s\S]*?&#039;|`[\s\S]*?`)/g, '<span style="color: #ce9178;">$1</span>')
            .replace(/(\/\/.x*?|\/\*[\s\S]*?\*\/)/g, '<span style="color: #6a9955;">$1</span>')
            .replace(/\b(const|let|var|function|return|if|else|for|while|import|export|from|async|await|class|try|catch|new|this)\b/g, '<span style="color: #569cd6;">$1</span>')
            .replace(/\b(true|false|null|undefined|NaN)\b/g, '<span style="color: #569cd6;">$1</span>')
            .replace(/\b(\d+)\b/g, '<span style="color: #b5cea8;">$1</span>');
    }

    if (["html", "xml", "svg"].includes(ext)) {
        return escaped
            .replace(/(&lt;\/?[a-zA-Z0-9\-]+)/g, '<span style="color: #569cd6;">$1</span>')
            .replace(/([a-zA-Z\-]+)=(&quot;.*?&quot;|&#039;.*?&#039;)/g, '<span style="color: #9cdcfe;">$1</span>=<span style="color: #ce9178;">$2</span>')
            .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span style="color: #6a9955;">$1</span>');
    }

    if (["css", "scss", "sass", "less"].includes(ext)) {
        return escaped
            .replace(/(\/\*[\s\S]*?\*\/)/g, '<span style="color: #6a9955;">$1</span>')
            .replace(/([a-zA-Z\-]+)\s*:/g, '<span style="color: #9cdcfe;">$1</span>:')
            .replace(/(#[a-fA-F0-9]{3,6}|\d+px|\d+rem|\d+%)/g, '<span style="color: #b5cea8;">$1</span>');
    }

    return escaped;
}

function updateDirtyIndicator(dirty) {
    isDirty = dirty;
    const dot = document.getElementById("saveIndicator");
    if (dot) {
        dot.className = "save-indicator " + (dirty ? "dirty" : "clean");
        dot.textContent = dirty ? "●" : "○";
    }
}
// #endregion

// #region Application Initialization
document.addEventListener("DOMContentLoaded", function () {
    // Start opening IndexedDB immediately, but do not assume Safari has finished
    // opening it before the user can tap GitHub/Import controls.
    initDatabase().catch(err => {
        console.error("IndexedDB initialization failed:", err);
        alert("[" + BUILD_ID + "] Local workspace storage could not be opened: " + err.message);
    });
    bindUIEvents();
    bindGitHubEvents();
    initSymbolBar();
    initQuickOpen();
    initThemeSelector();
    scheduleGitSyncStatusUpdate();
});

// Safari can restore a page from the back/forward cache with an old or closed
// IndexedDB connection. Re-open it whenever the page becomes active again.
window.addEventListener("pageshow", function () {
    getDatabase().then(() => loadFiles()).catch(err => {
        console.error("IndexedDB recovery failed:", err);
    });
});

function initDatabase() {
    if (db) return Promise.resolve(db);
    if (dbReadyPromise) return dbReadyPromise;

    dbReadyPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            dbReadyPromise = null;
            reject(new Error("IndexedDB is not available in this browser/session."));
            return;
        }

        let request;
        try {
            // v4 intentionally uses a NEW database name. This completely avoids
            // Safari/WebKit VersionError problems caused by an older deployment
            // leaving LocalWorkspaceDB at a higher schema version on this device.
            request = window.indexedDB.open(WORKSPACE_DB_NAME, WORKSPACE_DB_VERSION);
        } catch (err) {
            dbReadyPromise = null;
            reject(err);
            return;
        }

        request.onupgradeneeded = function (event) {
            const openedDb = event.target.result;
            if (!openedDb.objectStoreNames.contains("files")) {
                openedDb.createObjectStore("files", { keyPath: "name" });
            }
            if (!openedDb.objectStoreNames.contains("folders")) {
                openedDb.createObjectStore("folders", { keyPath: "path" });
            }
        };

        request.onsuccess = function (event) {
            db = event.target.result;

            db.onversionchange = function () {
                try { db.close(); } catch (e) {}
                db = undefined;
                dbReadyPromise = null;
            };

            // Let callers proceed only after Safari has returned a usable DB.
            resolve(db);

            // Non-critical startup work runs after the connection is established.
            Promise.resolve().then(() => loadFiles()).catch(console.error);
            restoreSettings();
        };

        request.onerror = function () {
            const err = request.error || new Error("IndexedDB failed to open.");
            console.error(BUILD_ID, "IndexedDB open failed", err);
            dbReadyPromise = null;
            reject(err);
        };

        request.onblocked = function () {
            console.warn(BUILD_ID, "IndexedDB open is blocked by another Safari tab/session.");
        };
    });

    return dbReadyPromise;
}

async function getDatabase() {
    if (db) {
        try {
            // Safari may keep the JS object around after closing the underlying DB.
            // A tiny readonly transaction verifies the connection is actually usable.
            db.transaction("files", "readonly");
            return db;
        } catch (err) {
            console.warn("IndexedDB connection was stale; reopening.", err);
            try { db.close(); } catch (e) {}
            db = undefined;
            dbReadyPromise = null;
        }
    }
    return initDatabase();
}

function restoreSettings() {
    const tokenInput = document.getElementById("tokenInput");
    if (tokenInput) {
        const token = localStorage.getItem("gh_token") || "";
        tokenInput.value = token;
        if (token) {
            fetchGitHubRepos(token);
        }
    }
    const savedTheme = localStorage.getItem("editor_theme") || "dark";
    const themeSelect = document.getElementById("themeSelect");
    if (themeSelect) {
        themeSelect.value = savedTheme;
        applyTheme(savedTheme);
    }
}

const tokenInputEl = document.getElementById("tokenInput");
if (tokenInputEl) {
    tokenInputEl.addEventListener("input", e => localStorage.setItem("gh_token", e.target.value.trim()));
}
// #endregion

// #region Theme Switching Logic
function initThemeSelector() {
    const themeSelect = document.getElementById("themeSelect");
    if (themeSelect) {
        themeSelect.addEventListener("change", function () {
            applyTheme(this.value);
            localStorage.setItem("editor_theme", this.value);
        });
    }
}

function applyTheme(theme) {
    document.body.classList.remove("theme-light", "theme-monokai");
    if (theme === "light") document.body.classList.add("theme-light");
    if (theme === "monokai") document.body.classList.add("theme-monokai");
}
// #endregion

// #region Accessory Keyboard & Quick Open Features
function initSymbolBar() {
    const symbols = ["{", "}", "(", ")", "[", "]", ";", "=", ":", "\"", "'", "<", ">", "/", "\\", "`", "$", "#", "|", "&"];
    const container = document.getElementById("symbolBar");
    if (!container) return;

    container.innerHTML = "";
    symbols.forEach(sym => {
        const btn = document.createElement("button");
        btn.className = "symbol-btn";
        btn.textContent = sym;
        btn.onclick = (e) => {
            e.preventDefault();
            insertSymbolAtCursor(sym);
        };
        container.appendChild(btn);
    });
}

function insertSymbolAtCursor(symbol) {
    const editor = document.getElementById("editor");
    if (!editor) return;

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const text = editor.value;

    editor.value = text.substring(0, start) + symbol + text.substring(end);
    editor.selectionStart = editor.selectionEnd = start + symbol.length;

    updateLineNumbers();
    updateHighlights();
    renderCodeBlockNav(editor.value);
    updateDirtyIndicator(true);
    autoSaveCurrentFile();
    editor.focus();
}

function initQuickOpen() {
    bindClick("quickOpenBtn", toggleQuickOpenModal);
    bindClick("closeQuickOpenModal", toggleQuickOpenModal);

    const input = document.getElementById("quickOpenInput");
    if (input) {
        input.addEventListener("input", function () {
            filterQuickOpenFiles(this.value.trim().toLowerCase());
        });
    }

    document.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
            e.preventDefault();
            toggleQuickOpenModal();
        }
    });
}

function toggleQuickOpenModal() {
    const modal = document.getElementById("quickOpenModal");
    if (!modal) return;
    const isHidden = modal.classList.toggle("hidden");
    if (!isHidden) {
        const input = document.getElementById("quickOpenInput");
        if (input) {
            input.value = "";
            input.focus();
        }
        filterQuickOpenFiles("");
    }
}

async function filterQuickOpenFiles(query) {
    const container = document.getElementById("quickOpenResults");
    if (!container) return;
    const database = await getDatabase();

    const tx = database.transaction("files", "readonly");
    const store = tx.objectStore("files");
    const req = store.getAllKeys();

    req.onsuccess = function () {
        const keys = req.result;
        container.innerHTML = "";

        const filtered = keys.filter(k => k.toLowerCase().includes(query));
        filtered.forEach(key => {
            const item = document.createElement("div");
            item.className = "quick-item";
            item.textContent = key;
            item.onclick = () => {
                openFile(key);
                toggleQuickOpenModal();
            };
            container.appendChild(item);
        });

        if (filtered.length === 0) {
            container.innerHTML = `<div style="padding:8px; font-size:0.8rem; color:#888;">No matching files</div>`;
        }
    };
}
// #endregion

// #region GitHub API Integration
function githubHeaders(token, extra = {}) {
    return {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...extra
    };
}

function githubRepoApiPath(repo) {
    return repo.split("/").map(part => encodeURIComponent(part)).join("/");
}

function githubBranchRefPath(branch) {
    return branch.split("/").map(part => encodeURIComponent(part)).join("/");
}

async function getGitHubError(res, fallback) {
    let detail = "";
    try {
        const data = await res.json();
        detail = data && data.message ? data.message : "";
    } catch (e) {
        try { detail = await res.text(); } catch (e2) {}
    }
    return `${fallback} (HTTP ${res.status}${detail ? `: ${detail}` : ""})`;
}

function base64ToBytes(base64) {
    const clean = (base64 || "").replace(/\s/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function decodeGitHubBlob(base64, path = "") {
    const bytes = base64ToBytes(base64);
    const likelyText = EXTENSION_REGEX.test(path.toLowerCase());

    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (likelyText || isTextContent(text)) return text;
    } catch (e) {}

    return `data:application/octet-stream;base64,${bytesToBase64(bytes)}`;
}

function workspaceContentToBytes(content) {
    if (typeof content === "string") {
        const match = content.match(/^data:[^;]*;base64,([A-Za-z0-9+/=\s]+)$/);
        if (match) return base64ToBytes(match[1]);
    }
    return new TextEncoder().encode(content == null ? "" : String(content));
}

function workspaceContentToGitHubBase64(content) {
    return bytesToBase64(workspaceContentToBytes(content));
}

async function hashWorkspaceContent(content) {
    const bytes = workspaceContentToBytes(content);
    if (window.crypto && window.crypto.subtle) {
        try {
            const digest = await window.crypto.subtle.digest("SHA-256", bytes);
            return "sha256:" + Array.from(new Uint8Array(digest))
                .map(value => value.toString(16).padStart(2, "0"))
                .join("");
        } catch (err) {
            console.warn("SHA-256 unavailable; using fallback workspace hash.", err);
        }
    }

    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}:${bytes.length}`;
}

async function getWorkspaceContentHash(name, content) {
    const cached = workspaceHashCache.get(name);
    if (cached && cached.content === content) return cached.hash;
    const hash = await hashWorkspaceContent(content);
    workspaceHashCache.set(name, { content, hash });
    return hash;
}

function loadGitSyncState() {
    try {
        const raw = localStorage.getItem(GIT_SYNC_STATE_KEY);
        if (!raw) return null;
        const state = JSON.parse(raw);
        if (!state || state.version !== 2 || !state.repo || !state.branch || !state.files) return null;
        return state;
    } catch (err) {
        console.warn("Could not read Git sync state.", err);
        return null;
    }
}

function saveGitSyncState(state) {
    localStorage.setItem(GIT_SYNC_STATE_KEY, JSON.stringify(state));
}

function syncStateMatches(state, repo, branch) {
    return !!state && state.repo === repo && state.branch === branch;
}

function setGitSyncProgress(message = "", kind = "") {
    const el = document.getElementById("ghSyncProgress");
    if (!el) return;
    el.textContent = message;
    el.className = "gh-sync-progress" + (kind ? ` ${kind}` : "");
}

function setPullButtonState(isBusy, label) {
    const btn = document.getElementById("pullGitHubBtn");
    if (!btn) return;
    btn.disabled = isBusy;
    btn.textContent = label || (isBusy ? "⬇️ Pulling..." : "⬇️ Pull Repo");
}

function setPushChangesButtonState(isBusy, label) {
    const btn = document.getElementById("pushAllGitHubBtn");
    if (!btn) return;
    btn.disabled = isBusy;
    if (label) btn.textContent = label;
}

function scheduleGitSyncStatusUpdate() {
    clearTimeout(gitSyncStatusTimer);
    gitSyncStatusTimer = setTimeout(() => {
        updateGitSyncStatus().catch(err => console.warn("Git sync status update failed", err));
    }, 180);
}

async function getAllWorkspaceFiles() {
    const database = await getDatabase();
    return new Promise((resolve, reject) => {
        let tx;
        try {
            tx = database.transaction("files", "readonly");
            const req = tx.objectStore("files").getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error || new Error("Could not read workspace files."));
        } catch (err) {
            reject(err);
        }
    });
}

async function calculateWorkspaceChanges(state) {
    const localFiles = await getAllWorkspaceFiles();
    const localMap = new Map(localFiles.map(file => [file.name, file]));
    const added = [];
    const modified = [];
    const deleted = [];
    const unchanged = [];

    for (const file of localFiles) {
        const baseline = state.files[file.name];
        const localHash = await getWorkspaceContentHash(file.name, file.content);
        if (!baseline) {
            added.push({ name: file.name, content: file.content, localHash, mode: "100644" });
        } else if (baseline.localHash !== localHash) {
            modified.push({
                name: file.name,
                content: file.content,
                localHash,
                mode: baseline.mode || "100644",
                previousBlobSha: baseline.blobSha || ""
            });
        } else {
            unchanged.push({ name: file.name, localHash });
        }
    }

    for (const [name, baseline] of Object.entries(state.files)) {
        if (!localMap.has(name)) {
            deleted.push({
                name,
                mode: baseline.mode || "100644",
                previousBlobSha: baseline.blobSha || ""
            });
        }
    }

    return { added, modified, deleted, unchanged, total: added.length + modified.length + deleted.length };
}

function describeChanges(changes) {
    return `${changes.modified.length} modified · ${changes.added.length} new · ${changes.deleted.length} deleted`;
}

async function updateGitSyncStatus() {
    const runId = ++gitSyncStatusRunId;
    const state = loadGitSyncState();
    const repo = document.getElementById("repoSelect")?.value || "";
    const branch = document.getElementById("branchSelect")?.value || "";
    const repoLabel = document.getElementById("ghSyncRepo");
    const branchLabel = document.getElementById("ghSyncBranch");
    const changesLabel = document.getElementById("ghSyncChanges");
    const pushBtn = document.getElementById("pushAllGitHubBtn");

    if (repoLabel) repoLabel.textContent = state ? state.repo : "Not bound yet";
    if (branchLabel) branchLabel.textContent = state ? state.branch : "—";

    if (!state) {
        if (changesLabel) changesLabel.textContent = "Pull a repo once to create a sync baseline.";
        if (pushBtn && !gitSyncBusy) {
            pushBtn.textContent = "☁️ Push Changes";
            pushBtn.disabled = true;
        }
        return;
    }

    if (!repo || !branch || !syncStateMatches(state, repo, branch)) {
        if (changesLabel) changesLabel.textContent = "Selected repo/branch differs from this workspace. Pull it before Push Changes.";
        if (pushBtn && !gitSyncBusy) {
            pushBtn.textContent = "☁️ Push Changes";
            pushBtn.disabled = true;
        }
        return;
    }

    const changes = await calculateWorkspaceChanges(state);
    if (runId !== gitSyncStatusRunId) return;

    if (changesLabel) {
        changesLabel.textContent = changes.total
            ? `${describeChanges(changes)} · ${changes.unchanged.length} unchanged`
            : `${changes.unchanged.length} unchanged · workspace matches GitHub`;
    }

    if (pushBtn && !gitSyncBusy) {
        pushBtn.textContent = changes.total ? `☁️ Push ${changes.total} Change${changes.total === 1 ? "" : "s"}` : "☁️ No Changes";
        pushBtn.disabled = changes.total === 0;
    }
}

async function getGitHubBranchHeadSha(token, repo, branch) {
    const repoPath = githubRepoApiPath(repo);
    const res = await fetch(`https://api.github.com/repos/${repoPath}/branches/${encodeURIComponent(branch)}`, {
        headers: githubHeaders(token)
    });
    if (!res.ok) throw new Error(await getGitHubError(res, `Could not resolve branch "${branch}"`));
    const data = await res.json();
    const sha = data.commit?.sha || "";
    if (!sha) throw new Error(`GitHub did not return a commit for branch "${branch}".`);
    return sha;
}

async function getGitHubCommit(token, repo, commitSha) {
    const repoPath = githubRepoApiPath(repo);
    const res = await fetch(`https://api.github.com/repos/${repoPath}/git/commits/${encodeURIComponent(commitSha)}`, {
        headers: githubHeaders(token)
    });
    if (!res.ok) throw new Error(await getGitHubError(res, "Could not resolve the branch commit"));
    return res.json();
}

function assertRemoteHeadMatches(state, remoteHeadSha) {
    if (state.lastCommitSha && state.lastCommitSha !== remoteHeadSha) {
        const localShort = state.lastCommitSha.slice(0, 7);
        const remoteShort = remoteHeadSha.slice(0, 7);
        throw new Error(`Remote branch changed since your last pull/push (${localShort} → ${remoteShort}). Pull the latest branch before pushing so remote work is not overwritten.`);
    }
}

async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runner() {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    }

    const runners = [];
    const count = Math.max(1, Math.min(limit, items.length || 1));
    for (let i = 0; i < count; i++) runners.push(runner());
    await Promise.all(runners);
    return results;
}

function bindGitHubEvents() {
    bindClick("connectGhBtn", async function() {
        const token = document.getElementById("tokenInput").value.trim();
        if (!token) return alert("Please enter a valid GitHub PAT first.");
        await fetchGitHubRepos(token);
        scheduleGitSyncStatusUpdate();
    });

    const repoSelect = document.getElementById("repoSelect");
    if (repoSelect) {
        repoSelect.addEventListener("change", async function() {
            const selectedRepo = this.value;
            localStorage.setItem("gh_repo", selectedRepo);

            const branchSelect = document.getElementById("branchSelect");
            if (!selectedRepo) {
                if (branchSelect) branchSelect.innerHTML = '<option value="">-- Choose Branch --</option>';
                scheduleGitSyncStatusUpdate();
                return;
            }

            const token = document.getElementById("tokenInput").value.trim();
            if (!token) return alert("Please enter your GitHub PAT first.");

            const selectedOption = this.options[this.selectedIndex];
            const defaultBranch = selectedOption ? selectedOption.dataset.defaultBranch || "" : "";
            await fetchGitHubBranches(token, selectedRepo, defaultBranch);
            scheduleGitSyncStatusUpdate();
        });
    }

    const branchSelect = document.getElementById("branchSelect");
    if (branchSelect) {
        branchSelect.addEventListener("change", function() {
            localStorage.setItem("gh_branch", this.value);
            scheduleGitSyncStatusUpdate();
        });
    }

    bindClick("pullGitHubBtn", async function() {
        const token = document.getElementById("tokenInput")?.value.trim() || "";
        const repo = document.getElementById("repoSelect")?.value || "";
        const branch = document.getElementById("branchSelect")?.value || "";

        if (!token) return alert("Enter your GitHub PAT first.");
        if (!repo) return alert("Choose a GitHub repository first.");
        if (!branch) return alert("Choose a branch first.");

        if (!confirm(`Pull "${repo}" (${branch}) into this workspace?

This is a clean checkout: after GitHub finishes downloading successfully, the local Workspace will be replaced with exactly this branch. Local-only files will be removed.

Export a workspace backup first if you need to keep unsynced local files.`)) return;

        gitSyncBusy = true;
        setPullButtonState(true);
        setPushChangesButtonState(true, "☁️ Sync Busy");
        setGitSyncProgress("Resolving GitHub branch…");
        try {
            await importRepoFromGitHub(token, repo, branch);
        } finally {
            gitSyncBusy = false;
            setPullButtonState(false);
            await updateGitSyncStatus();
        }
    });
}

async function fetchGitHubRepos(token) {
    const repoSelect = document.getElementById("repoSelect");
    const branchSelect = document.getElementById("branchSelect");
    if (!repoSelect) return;
    repoSelect.innerHTML = '<option value="">Loading repositories...</option>';
    if (branchSelect) branchSelect.innerHTML = '<option value="">-- Choose Repository First --</option>';

    try {
        const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
            headers: githubHeaders(token)
        });

        if (!res.ok) throw new Error(await getGitHubError(res, "Could not load repositories"));

        const repos = await res.json();
        repoSelect.innerHTML = '<option value="">-- Choose Repository --</option>';

        const savedRepo = localStorage.getItem("gh_repo");
        let savedDefaultBranch = "";

        repos.forEach(repo => {
            const opt = document.createElement("option");
            opt.value = repo.full_name;
            opt.textContent = repo.full_name;
            opt.dataset.defaultBranch = repo.default_branch || "";
            if (savedRepo && repo.full_name === savedRepo) {
                opt.selected = true;
                savedDefaultBranch = repo.default_branch || "";
            }
            repoSelect.appendChild(opt);
        });

        if (savedRepo && repoSelect.value === savedRepo) {
            await fetchGitHubBranches(token, savedRepo, savedDefaultBranch);
        }
        scheduleGitSyncStatusUpdate();
    } catch (err) {
        repoSelect.innerHTML = '<option value="">Failed to load repos</option>';
        if (branchSelect) branchSelect.innerHTML = '<option value="">-- Choose Repository First --</option>';
        alert("GitHub API Error: " + err.message);
    }
}

async function fetchGitHubBranches(token, repo, defaultBranch = "") {
    const branchSelect = document.getElementById("branchSelect");
    if (!branchSelect) return [];
    branchSelect.disabled = true;
    branchSelect.innerHTML = '<option value="">Loading branches...</option>';

    try {
        const repoPath = githubRepoApiPath(repo);
        const res = await fetch(`https://api.github.com/repos/${repoPath}/branches?per_page=100`, {
            headers: githubHeaders(token)
        });

        if (!res.ok) throw new Error(await getGitHubError(res, "Could not fetch branches"));

        const branches = await res.json();
        branchSelect.innerHTML = "";

        if (!branches.length) {
            branchSelect.innerHTML = '<option value="">No branches found</option>';
            return [];
        }

        const savedBranch = localStorage.getItem("gh_branch");
        const branchNames = new Set(branches.map(branch => branch.name));
        const preferredBranch = (savedBranch && branchNames.has(savedBranch))
            ? savedBranch
            : (defaultBranch && branchNames.has(defaultBranch) ? defaultBranch : branches[0].name);

        branches.forEach(branch => {
            const opt = document.createElement("option");
            opt.value = branch.name;
            opt.textContent = branch.name;
            opt.dataset.commitSha = branch.commit?.sha || "";
            if (branch.name === preferredBranch) opt.selected = true;
            branchSelect.appendChild(opt);
        });

        localStorage.setItem("gh_branch", branchSelect.value);
        scheduleGitSyncStatusUpdate();
        return branches;
    } catch (err) {
        branchSelect.innerHTML = '<option value="">Failed to load branches</option>';
        alert("GitHub Branch Error: " + err.message);
        return [];
    } finally {
        branchSelect.disabled = false;
    }
}

async function replaceWorkspaceWithDownloadedFiles(downloadedFiles) {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
        let tx;
        try {
            const stores = database.objectStoreNames.contains("folders") ? ["files", "folders"] : ["files"];
            tx = database.transaction(stores, "readwrite");
            const fileStore = tx.objectStore("files");
            fileStore.clear();
            if (stores.includes("folders")) tx.objectStore("folders").clear();

            for (const file of downloadedFiles) {
                fileStore.put({ name: file.path, content: file.content });
            }
        } catch (err) {
            reject(err);
            return;
        }

        tx.oncomplete = () => {
            workspaceHashCache.clear();
            selectedFolderPath = "";
            expandedFolderPaths.clear();
            resolve();
        };
        tx.onerror = () => reject(tx.error || new Error("Could not replace the local workspace."));
        tx.onabort = () => reject(tx.error || new Error("Replacing the local workspace was aborted."));
    });
}

function refreshEditorAfterWorkspaceReplace(downloadedFiles) {
    const editor = document.getElementById("editor");
    if (!editor) return;

    const activeName = editor.dataset.filename || "";
    if (!activeName) return;

    const match = downloadedFiles.find(file => file.path === activeName);
    if (match) {
        let content = match.content;
        if (typeof content === "string" && content.startsWith("data:application/octet-stream;base64,")) {
            content = decodeBase64Text(content);
        }
        editor.value = content;
        updateLineNumbers();
        updateHighlights();
        renderCodeBlockNav(content);
        updateDirtyIndicator(false);
        return;
    }

    editor.value = "";
    editor.dataset.filename = "";
    const label = document.getElementById("activeFileLabel");
    if (label) label.textContent = "No file selected";
    updateLineNumbers();
    updateHighlights();
    renderCodeBlockNav("");
    updateBreadcrumbs("");
    updateDirtyIndicator(false);
}

async function importRepoFromGitHub(token, repo, branch) {
    await getDatabase();
    let workspaceReplaced = false;

    try {
        const repoPath = githubRepoApiPath(repo);
        const commitSha = await getGitHubBranchHeadSha(token, repo, branch);
        setGitSyncProgress(`Resolved ${branch} @ ${commitSha.slice(0, 7)}. Loading tree…`);

        const commitData = await getGitHubCommit(token, repo, commitSha);
        const treeSha = commitData.tree?.sha;
        if (!treeSha) throw new Error("GitHub did not return a tree for the selected branch.");

        const treeRes = await fetch(`https://api.github.com/repos/${repoPath}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, {
            headers: githubHeaders(token)
        });
        if (!treeRes.ok) throw new Error(await getGitHubError(treeRes, "Unable to fetch repository file tree"));

        const data = await treeRes.json();
        if (!Array.isArray(data.tree)) throw new Error("GitHub returned an invalid repository tree.");
        if (data.truncated) {
            throw new Error("This repository tree is too large for GitHub's recursive tree response. Pull was stopped so files are not silently omitted.");
        }

        const filesToFetch = data.tree.filter(item => item.type === "blob");
        let downloadedCount = 0;

        // Download everything first. The local workspace is not changed until
        // every remote blob has arrived successfully.
        const downloadedFiles = await mapWithConcurrency(filesToFetch, 5, async file => {
            const fileRes = await fetch(file.url, { headers: githubHeaders(token) });
            if (!fileRes.ok) {
                throw new Error(await getGitHubError(fileRes, `Could not download "${file.path}"`));
            }

            const blobData = await fileRes.json();
            if (blobData.encoding !== "base64" || typeof blobData.content !== "string") {
                throw new Error(`GitHub returned an unsupported blob response for "${file.path}".`);
            }

            const content = decodeGitHubBlob(blobData.content, file.path);
            const localHash = await hashWorkspaceContent(content);
            downloadedCount++;
            setPullButtonState(true, `⬇️ Pulling ${downloadedCount}/${filesToFetch.length || 1}`);
            setGitSyncProgress(`Downloaded ${downloadedCount}/${filesToFetch.length}: ${file.path}`);

            return {
                path: file.path,
                content,
                blobSha: file.sha || blobData.sha || "",
                localHash,
                mode: file.mode || "100644"
            };
        });

        setPullButtonState(true, "⬇️ Updating Workspace");
        setGitSyncProgress("All GitHub files downloaded. Replacing local workspace…");

        // Clean checkout: remove local leftovers that are not part of this branch,
        // then write the downloaded repository in one IndexedDB transaction.
        await replaceWorkspaceWithDownloadedFiles(downloadedFiles);
        workspaceReplaced = true;

        const baselineFiles = {};
        for (const file of downloadedFiles) {
            baselineFiles[file.path] = {
                blobSha: file.blobSha,
                localHash: file.localHash,
                mode: file.mode
            };
        }

        saveGitSyncState({
            version: 2,
            repo,
            branch,
            lastCommitSha: commitSha,
            treeSha,
            files: baselineFiles,
            syncedAt: Date.now()
        });

        const branchSelect = document.getElementById("branchSelect");
        if (branchSelect?.selectedOptions?.[0]) branchSelect.selectedOptions[0].dataset.commitSha = commitSha;

        refreshEditorAfterWorkspaceReplace(downloadedFiles);
        try {
            window.dispatchEvent(new CustomEvent("workspace:replaced", { detail: { repo, branch } }));
        } catch (_) {}
        await loadFiles();
        setGitSyncProgress(`Pull complete: ${downloadedFiles.length} files synced @ ${commitSha.slice(0, 7)}.`, "success");

        if (downloadedFiles.length) {
            alert(`Successfully pulled ${downloadedFiles.length} file(s) from ${repo} (${branch}).\n\nWorkspace now exactly matches this GitHub branch.`);
        } else {
            alert(`Branch "${branch}" contains no files.\n\nThe local workspace was cleared to match the branch.`);
        }
    } catch (err) {
        setGitSyncProgress("Pull failed: " + err.message, "error");
        const suffix = workspaceReplaced
            ? "\n\nThe repository files were already downloaded into the local workspace, but final sync bookkeeping did not complete. Pull again before pushing."
            : "\n\nYour existing local workspace was left unchanged.";
        alert("Repository Pull Failed: " + err.message + suffix);
    }
}

async function pushFileToGitHub(name, content, token, repo, branch) {
    if (!branch) throw new Error("Choose a GitHub branch first.");

    const repoPath = githubRepoApiPath(repo);
    const encodedPath = name.split("/").map(part => encodeURIComponent(part)).join("/");
    const url = `https://api.github.com/repos/${repoPath}/contents/${encodedPath}`;
    const headers = githubHeaders(token, { "Content-Type": "application/json" });
    const state = loadGitSyncState();
    const hasMatchingBaseline = syncStateMatches(state, repo, branch);

    let sha = null;
    if (hasMatchingBaseline) {
        const remoteHeadSha = await getGitHubBranchHeadSha(token, repo, branch);
        assertRemoteHeadMatches(state, remoteHeadSha);
        sha = state.files[name]?.blobSha || null;
    } else {
        const getRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
        if (getRes.ok) {
            const fileData = await getRes.json();
            sha = fileData.sha;
        } else if (getRes.status !== 404) {
            throw new Error(await getGitHubError(getRes, `Could not check existing GitHub file "${name}"`));
        }
    }

    const body = {
        message: `Update ${name} via Mobile Workspace`,
        content: workspaceContentToGitHubBase64(content),
        branch,
        ...(sha && { sha })
    };

    const putRes = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(body)
    });

    if (!putRes.ok) {
        throw new Error(await getGitHubError(putRes, `GitHub rejected the push for "${name}"`));
    }

    const result = await putRes.json();
    if (hasMatchingBaseline) {
        state.files[name] = {
            blobSha: result.content?.sha || sha || "",
            localHash: await getWorkspaceContentHash(name, content),
            mode: state.files[name]?.mode || "100644"
        };
        state.lastCommitSha = result.commit?.sha || state.lastCommitSha;
        state.syncedAt = Date.now();
        saveGitSyncState(state);
        const branchSelect = document.getElementById("branchSelect");
        if (branchSelect?.selectedOptions?.[0] && state.lastCommitSha) {
            branchSelect.selectedOptions[0].dataset.commitSha = state.lastCommitSha;
        }
        scheduleGitSyncStatusUpdate();
    }

    return result;
}

async function pushChangedFilesToGitHub(token, repo, branch, preparedChanges = null) {
    const state = loadGitSyncState();
    if (!syncStateMatches(state, repo, branch)) {
        throw new Error("This workspace does not have a sync baseline for the selected repo/branch. Pull it once first, then Push Changes will send only modified/new/deleted files.");
    }

    const changes = preparedChanges || await calculateWorkspaceChanges(state);
    if (!changes.total) {
        setGitSyncProgress("Workspace already matches GitHub.", "success");
        return { pushed: 0, changes };
    }

    setGitSyncProgress(`Checking remote branch before pushing ${changes.total} change(s)…`);
    const remoteHeadSha = await getGitHubBranchHeadSha(token, repo, branch);
    assertRemoteHeadMatches(state, remoteHeadSha);

    const commitData = await getGitHubCommit(token, repo, remoteHeadSha);
    const baseTreeSha = commitData.tree?.sha;
    if (!baseTreeSha) throw new Error("GitHub did not return the current branch tree.");

    const repoPath = githubRepoApiPath(repo);
    const changedFiles = [
        ...changes.modified.map(item => ({ ...item, kind: "modified" })),
        ...changes.added.map(item => ({ ...item, kind: "added" }))
    ];

    let uploadedCount = 0;
    const uploaded = await mapWithConcurrency(changedFiles, 5, async item => {
        const res = await fetch(`https://api.github.com/repos/${repoPath}/git/blobs`, {
            method: "POST",
            headers: githubHeaders(token, { "Content-Type": "application/json" }),
            body: JSON.stringify({
                content: workspaceContentToGitHubBase64(item.content),
                encoding: "base64"
            })
        });
        if (!res.ok) throw new Error(await getGitHubError(res, `Could not upload "${item.name}"`));
        const blob = await res.json();
        uploadedCount++;
        setPushChangesButtonState(true, `☁️ Uploading ${uploadedCount}/${changedFiles.length}`);
        setGitSyncProgress(`Uploaded ${uploadedCount}/${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}…`);
        return { ...item, blobSha: blob.sha };
    });

    setPushChangesButtonState(true, "☁️ Building Commit");
    setGitSyncProgress("Building one Git tree for all changes…");
    const treeEntries = uploaded.map(item => ({
        path: item.name,
        mode: item.mode || "100644",
        type: "blob",
        sha: item.blobSha
    }));

    for (const item of changes.deleted) {
        treeEntries.push({
            path: item.name,
            mode: item.mode || "100644",
            type: "blob",
            sha: null
        });
    }

    const treeRes = await fetch(`https://api.github.com/repos/${repoPath}/git/trees`, {
        method: "POST",
        headers: githubHeaders(token, { "Content-Type": "application/json" }),
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries })
    });
    if (!treeRes.ok) throw new Error(await getGitHubError(treeRes, "GitHub could not build the commit tree"));
    const newTree = await treeRes.json();

    const parts = [];
    if (changes.modified.length) parts.push(`${changes.modified.length} modified`);
    if (changes.added.length) parts.push(`${changes.added.length} added`);
    if (changes.deleted.length) parts.push(`${changes.deleted.length} deleted`);
    const commitMessage = `Mobile Workspace: ${parts.join(", ")}`;

    setGitSyncProgress("Creating GitHub commit…");
    const commitRes = await fetch(`https://api.github.com/repos/${repoPath}/git/commits`, {
        method: "POST",
        headers: githubHeaders(token, { "Content-Type": "application/json" }),
        body: JSON.stringify({
            message: commitMessage,
            tree: newTree.sha,
            parents: [remoteHeadSha]
        })
    });
    if (!commitRes.ok) throw new Error(await getGitHubError(commitRes, "GitHub could not create the commit"));
    const newCommit = await commitRes.json();

    setPushChangesButtonState(true, "☁️ Updating Branch");
    setGitSyncProgress(`Updating ${branch} to ${newCommit.sha.slice(0, 7)}…`);
    const refRes = await fetch(`https://api.github.com/repos/${repoPath}/git/refs/heads/${githubBranchRefPath(branch)}`, {
        method: "PATCH",
        headers: githubHeaders(token, { "Content-Type": "application/json" }),
        body: JSON.stringify({ sha: newCommit.sha, force: false })
    });
    if (!refRes.ok) {
        const detail = await getGitHubError(refRes, "GitHub could not update the branch");
        throw new Error(`${detail}. The branch may have changed while this push was being prepared; pull and try again.`);
    }

    for (const item of uploaded) {
        state.files[item.name] = {
            blobSha: item.blobSha,
            localHash: item.localHash,
            mode: item.mode || "100644"
        };
    }
    for (const item of changes.deleted) delete state.files[item.name];

    state.lastCommitSha = newCommit.sha;
    state.treeSha = newTree.sha;
    state.syncedAt = Date.now();
    saveGitSyncState(state);

    const branchSelect = document.getElementById("branchSelect");
    if (branchSelect?.selectedOptions?.[0]) branchSelect.selectedOptions[0].dataset.commitSha = newCommit.sha;

    setGitSyncProgress(`Push complete: ${changes.total} change(s) in commit ${newCommit.sha.slice(0, 7)}.`, "success");
    return { pushed: changes.total, changes, commitSha: newCommit.sha };
}
// #endregion

// #region Code Block Navigation Logic
function parseCodeBlocks(content) {
    const lines = content.split('\n');
    const blocks = [];
    let currentBlock = null;

    lines.forEach((line, index) => {
        const regionStart = line.match(/\/\/\s*#(?:region|block)\s+(.*)/i);
        const regionEnd = line.match(/\/\/\s*#end(?:region|block)/i);

        if (regionStart) {
            currentBlock = { name: regionStart[1].trim(), startLine: index + 1 };
        } else if (regionEnd && currentBlock) {
            currentBlock.endLine = index + 1;
            blocks.push(currentBlock);
            currentBlock = null;
        }
    });

    return blocks;
}

function renderCodeBlockNav(content) {
    const navContainer = document.getElementById("blockNav");
    if (!navContainer) return;

    const blocks = parseCodeBlocks(content);
    navContainer.innerHTML = "";

    if (blocks.length === 0) {
        navContainer.innerHTML = `<span class="no-blocks">No defined #region blocks</span>`;
        return;
    }

    blocks.forEach(block => {
        const item = document.createElement("div");
        item.className = "block-nav-item";
        item.innerHTML = `🧩 <strong>${block.name}</strong> <small>(L${block.startLine}-${block.endLine})</small>`;
        item.onclick = () => jumpToLine(block.startLine);
        navContainer.appendChild(item);
    });
}

function jumpToLine(lineNumber) {
    const editor = document.getElementById("editor");
    if (!editor) return;
    const lineHeight = 20;
    editor.scrollTop = (lineNumber - 1) * lineHeight;
    editor.focus();
}
// #endregion

// #region UI Event Handlers & Editor Controls
function closeCurrentFile() {
    const editor = document.getElementById("editor");
    if (!editor) return "";

    const closingPath = editor.dataset.filename || "";
    editor.value = "";
    editor.dataset.filename = "";

    const label = document.getElementById("activeFileLabel");
    if (label) label.textContent = "No file selected";

    updateLineNumbers();
    updateHighlights();
    renderCodeBlockNav("");
    updateBreadcrumbs("");
    updateDirtyIndicator(false);

    if (closingPath) {
        try {
            window.dispatchEvent(new CustomEvent('workspace:file-closed', { detail: { path: closingPath } }));
        } catch (e) {}
    }

    return closingPath;
}

function bindUIEvents() {
    const editor = document.getElementById("editor");
    const highlightLayer = document.getElementById("highlightLayer");
    const lineNumbers = document.getElementById("lineNumbers");
    const searchInput = document.getElementById("searchInput");

    bindClick("tabExplorer", () => switchTab('explorer'));
    bindClick("tabEditor", () => switchTab('editor'));

    if (editor) {
        editor.addEventListener("input", function () {
            updateLineNumbers();
            updateHighlights();
            renderCodeBlockNav(this.value);
            updateDirtyIndicator(true);
            autoSaveCurrentFile();
        });

        editor.addEventListener("keydown", function (e) {
            if (e.key === "Tab") {
                e.preventDefault();
                const start = this.selectionStart;
                const end = this.selectionEnd;

                this.value = this.value.substring(0, start) + "    " + this.value.substring(end);
                this.selectionStart = this.selectionEnd = start + 4;
                updateLineNumbers();
                updateHighlights();
                renderCodeBlockNav(this.value);
                updateDirtyIndicator(true);
            }

            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                saveCurrentFile(true);
            }
        });

        editor.addEventListener("scroll", function () {
            if (lineNumbers) lineNumbers.scrollTop = editor.scrollTop;
            if (highlightLayer) {
                highlightLayer.scrollTop = editor.scrollTop;
                highlightLayer.scrollLeft = editor.scrollLeft;
            }
        });
    }

    if (searchInput) {
        searchInput.addEventListener("input", updateHighlights);
    }

    bindClick("closeFileBtn", async function () {
        const currentName = editor?.dataset?.filename || "";
        if (currentName && isDirty) {
            clearTimeout(autoSaveTimeout);
            try {
                await saveFileToDb(currentName, editor.value);
                updateDirtyIndicator(false);
            } catch (err) {
                return alert("Could not save before closing: " + (err.message || err));
            }
        }
        closeCurrentFile();
    });

    bindClick("searchToggleBtn", function () {
        const bar = document.getElementById("searchReplaceBar");
        if (bar) bar.classList.toggle("hidden");
        updateHighlights();
    });

    bindClick("fullscreenBtn", function () {
        const appContainer = document.getElementById("appContainer");
        const isFullscreen = appContainer.classList.toggle("fullscreen");
        const btn = document.getElementById("fullscreenBtn");
        if (btn) btn.textContent = isFullscreen ? "⛶ Exit" : "⛶ Fullscreen";
    });

    bindClick("splitPaneBtn", toggleSplitPane);
    bindClick("closeSplitBtn", toggleSplitPane);

    bindClick("jumpLineBtn", function () {
        const lineStr = prompt("Enter line number:");
        if (!lineStr) return;
        const lineNum = parseInt(lineStr, 10);
        if (!isNaN(lineNum) && lineNum > 0) {
            jumpToLine(lineNum);
        }
    });

    bindClick("exportWorkspaceBtn", async function () {
        if (typeof JSZip === "undefined") return alert("JSZip library failed to load.");
        try {
            const [files, folders] = await Promise.all([getAllWorkspaceFiles(), getAllWorkspaceFolders()]);
            if (files.length === 0 && folders.length === 0) return alert("Workspace is empty.");

            const zip = new JSZip();
            folders.forEach(path => zip.folder(path));
            files.forEach(file => {
                const content = file.content;
                if (typeof content === "string") {
                    const binaryMatch = content.match(/^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/);
                    if (binaryMatch) {
                        zip.file(file.name, binaryMatch[2].replace(/\s/g, ""), { base64: true });
                        return;
                    }
                }
                zip.file(file.name, content);
            });

            const blob = await zip.generateAsync({ type: "blob" });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `workspace_backup_${new Date().toISOString().slice(0, 10)}.zip`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 0);
        } catch (err) {
            alert("Export failed: " + (err.message || err));
        }
    });

    bindClick("findNextBtn", function () {
        const searchVal = document.getElementById("searchInput").value;
        if (!searchVal) return alert("Enter text to find.");
        if (!editor) return;

        const text = editor.value;
        const lowerText = text.toLowerCase();
        const lowerSearch = searchVal.toLowerCase();

        let index = lowerText.indexOf(lowerSearch, lastSearchIndex);

        if (index === -1) {
            index = lowerText.indexOf(lowerSearch, 0);
        }

        if (index !== -1) {
            editor.focus();
            editor.setSelectionRange(index, index + searchVal.length);
            lastSearchIndex = index + searchVal.length;

            const linesBefore = text.substring(0, index).split("\n").length;
            const lineHeight = 20;
            editor.scrollTop = (linesBefore - 2) * lineHeight;
            
            updateHighlights();
        } else {
            alert(`No matches found for "${searchVal}".`);
            lastSearchIndex = 0;
        }
    });

    bindClick("replaceBtn", function () {
        const searchVal = document.getElementById("searchInput").value;
        const replaceVal = document.getElementById("replaceInput").value;

        if (!searchVal) return alert("Enter text to find.");
        if (!editor) return;

        const text = editor.value;
        if (!text.includes(searchVal)) {
            return alert(`Text "${searchVal}" not found.`);
        }

        if (confirm(`Replace next instance of "${searchVal}" with "${replaceVal}"?`)) {
            editor.value = text.replace(searchVal, replaceVal);
            updateLineNumbers();
            updateHighlights();
            renderCodeBlockNav(editor.value);
            updateDirtyIndicator(true);
            autoSaveCurrentFile();
        }
    });

    bindClick("replaceAllBtn", function () {
        const searchVal = document.getElementById("searchInput").value;
        const replaceVal = document.getElementById("replaceInput").value;

        if (!searchVal) return alert("Enter text to find.");
        if (!editor) return;

        const regex = new RegExp(escapeRegExp(searchVal), "g");
        const matches = (editor.value.match(regex) || []).length;

        if (matches === 0) {
            return alert(`No occurrences of "${searchVal}" found.`);
        }

        if (confirm(`Replace all ${matches} occurrence(s) of "${searchVal}" with "${replaceVal}"?`)) {
            editor.value = editor.value.replace(regex, replaceVal);
            updateLineNumbers();
            updateHighlights();
            renderCodeBlockNav(editor.value);
            updateDirtyIndicator(true);
            autoSaveCurrentFile();
            alert(`Replaced ${matches} instance(s).`);
        }
    });

    bindClick("saveLocalBtn", function () {
        saveCurrentFile(true);
    });

    bindClick("newFileBtn", function () {
        const defaultPath = selectedFolderPath ? `${selectedFolderPath}/` : "";
        const input = prompt("Enter file path:", defaultPath);
        const name = normalizeWorkspacePath(input || "");
        if (!name) return;
        const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";

        (async () => {
            const [files, folders] = await Promise.all([getAllWorkspaceFiles(), getAllWorkspaceFolders()]);
            if (folders.includes(name)) return alert(`A folder already exists at "${name}". Choose a different file path.`);
            if (files.some(file => file.name === name) && !confirm(`"${name}" already exists. Replace it with an empty file?`)) return;
            if (parent) await ensureFolderPath(parent);
            await saveFileToDb(name, "");
            await loadFiles();
            await openFile(name);
        })().catch(err => alert("Could not create file: " + (err.message || err)));
    });

    bindClick("newFolderBtn", async function () {
        const defaultPath = selectedFolderPath ? `${selectedFolderPath}/New Folder` : "New Folder";
        const input = prompt("Enter folder path:", defaultPath);
        if (!input) return;
        const path = normalizeWorkspacePath(input);
        if (!path) return alert("Enter a valid folder name.");
        try {
            const files = await getAllWorkspaceFiles();
            if (files.some(file => file.name === path)) return alert(`A file already exists at "${path}". Choose a different folder path.`);
            await ensureFolderPath(path);
            selectedFolderPath = path;
            expandFolderPath(path);
            await loadFiles();
        } catch (err) {
            alert("Could not create folder: " + (err.message || err));
        }
    });

    bindClick("pushGitHubBtn", async function () {
        const tokenInput = document.getElementById("tokenInput");
        const repoSelect = document.getElementById("repoSelect");
        const branchSelect = document.getElementById("branchSelect");

        const token = tokenInput ? tokenInput.value.trim() : "";
        const repo = repoSelect ? repoSelect.value : "";
        const branch = branchSelect ? branchSelect.value : "";
        const name = editor ? editor.dataset.filename : "";
        const content = editor ? editor.value : "";

        if (!token || !repo || !name) return alert("Select a file & specify GitHub credentials.");
        if (!branch) return alert("Choose a GitHub branch first.");

        try {
            await saveFileToDb(name, content);
            updateDirtyIndicator(false);
            setGitSyncProgress(`Pushing ${name}…`);
            await pushFileToGitHub(name, content, token, repo, branch);
            setGitSyncProgress(`Pushed ${name} successfully.`, "success");
            alert(`Pushed ${name} successfully!`);
        } catch (err) {
            setGitSyncProgress("Push failed: " + err.message, "error");
            alert("Push failed: " + err.message);
        }
    });

    bindClick("pushAllGitHubBtn", async function () {
        const tokenInput = document.getElementById("tokenInput");
        const repoSelect = document.getElementById("repoSelect");
        const branchSelect = document.getElementById("branchSelect");

        const token = tokenInput ? tokenInput.value.trim() : "";
        const repo = repoSelect ? repoSelect.value : "";
        const branch = branchSelect ? branchSelect.value : "";

        if (!token || !repo) return alert("Configure GitHub credentials first.");
        if (!branch) return alert("Choose a GitHub branch first.");
        if (gitSyncBusy) return;

        const activeName = editor ? editor.dataset.filename : "";
        if (activeName && isDirty) {
            await saveFileToDb(activeName, editor.value);
            updateDirtyIndicator(false);
        }

        const state = loadGitSyncState();
        if (!syncStateMatches(state, repo, branch)) {
            return alert("Pull this repository/branch once first. That creates the baseline used to detect only modified, new, deleted, moved, or renamed files.");
        }

        let changes;
        try {
            changes = await calculateWorkspaceChanges(state);
        } catch (err) {
            return alert("Could not scan workspace changes: " + err.message);
        }

        if (!changes.total) {
            setGitSyncProgress("Workspace already matches GitHub.", "success");
            await updateGitSyncStatus();
            return alert("No GitHub changes to push.");
        }

        if (!confirm(`Push ${changes.total} change(s) to ${repo} (${branch}) as one commit?\n\n${describeChanges(changes)}\n${changes.unchanged.length} unchanged file(s) will be skipped.`)) return;

        gitSyncBusy = true;
        setPullButtonState(true, "⬇️ Sync Busy");
        setPushChangesButtonState(true, `☁️ Pushing ${changes.total}`);
        try {
            const result = await pushChangedFilesToGitHub(token, repo, branch, changes);
            if (result.pushed) {
                alert(`Pushed ${result.pushed} changed file(s) in one commit (${result.commitSha.slice(0, 7)}).\n\nUnchanged files were skipped.`);
            }
        } catch (err) {
            console.error(err);
            setGitSyncProgress("Push failed: " + err.message, "error");
            alert("Push Changes failed: " + err.message);
        } finally {
            gitSyncBusy = false;
            setPullButtonState(false);
            await updateGitSyncStatus();
        }
    });
}

function saveCurrentFile(showAlert = false) {
    const editor = document.getElementById("editor");
    if (!editor) return;
    const name = editor.dataset.filename;
    if (!name) {
        if (showAlert) alert("Select a file first.");
        return;
    }

    saveFileToDb(name, editor.value).then(() => {
        updateDirtyIndicator(false);
        if (showAlert) alert("Saved locally!");
    });
}

let autoSaveTimeout;
function autoSaveCurrentFile() {
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => {
        saveCurrentFile(false);
    }, 1000);
}

function updateLineNumbers() {
    const editor = document.getElementById("editor");
    const lineNumbers = document.getElementById("lineNumbers");
    if (!editor || !lineNumbers) return;

    const lines = editor.value.split("\n").length;
    let numbersArr = [];
    for (let i = 1; i <= lines; i++) {
        numbersArr.push(i);
    }
    lineNumbers.textContent = numbersArr.join("\n");
}

function updateHighlights() {
    const editor = document.getElementById("editor");
    const highlightCode = document.getElementById("highlightCode");
    const highlightLayer = document.getElementById("highlightLayer");
    const searchInput = document.getElementById("searchInput");
    const searchBar = document.getElementById("searchReplaceBar");

    if (!editor) return;

    let text = editor.value;
    const filename = editor.dataset.filename || "";
    
    if (text.endsWith("\n")) {
        text += " ";
    }

    const searchVal = searchInput ? searchInput.value : "";
    const isSearchActive = searchVal && searchBar && !searchBar.classList.contains("hidden");

    if (highlightCode) {
        const ext = filename.split('.').pop().toLowerCase();
        const langMap = { js: 'javascript', ts: 'typescript', py: 'python', md: 'markdown', html: 'markup', css: 'css', json: 'json' };
        const lang = langMap[ext] || 'plaintext';

        if (window.Prism && Prism.languages[lang]) {
            let highlighted = Prism.highlight(text, Prism.languages[lang], lang);
            if (isSearchActive) {
                const escapedSearch = escapeHtml(searchVal);
                const regex = new RegExp(`(${escapeRegExp(escapedSearch)})`, "gi");
                highlighted = highlighted.replace(regex, `<mark class="search-highlight">$1</mark>`);
            }
            highlightCode.innerHTML = highlighted;
            return;
        }
    }

    let renderedText = applySyntaxHighlighting(text, filename);

    if (isSearchActive) {
        const escapedSearch = escapeHtml(searchVal);
        const regex = new RegExp(`(${escapeRegExp(escapedSearch)})`, "gi");
        renderedText = renderedText.replace(regex, `<mark class="search-highlight">$1</mark>`);
    }

    if (highlightCode) {
        highlightCode.innerHTML = renderedText;
    } else if (highlightLayer) {
        highlightLayer.innerHTML = renderedText;
    }
}

function updateBreadcrumbs(filePath) {
    const container = document.getElementById("breadcrumbBar");
    if (!container) return;
    container.innerHTML = "";

    if (!filePath) {
        container.innerHTML = `<span class="breadcrumb-item">Workspace</span>`;
        return;
    }

    const parts = filePath.split('/');
    let cumulative = "";

    const rootItem = document.createElement("span");
    rootItem.className = "breadcrumb-item";
    rootItem.textContent = "Workspace";
    rootItem.onclick = () => { selectedFolderPath = ""; loadFiles(); };
    container.appendChild(rootItem);

    parts.forEach((part, index) => {
        const sep = document.createElement("span");
        sep.className = "breadcrumb-separator";
        sep.textContent = " / ";
        container.appendChild(sep);

        cumulative += (index === 0 ? "" : "/") + part;
        const item = document.createElement("span");
        item.className = "breadcrumb-item";
        item.textContent = part;

        if (index === parts.length - 1) {
            item.style.color = "#d4d4d4";
        } else {
            const pathCopy = cumulative;
            item.onclick = () => selectFolderByPath(pathCopy);
        }
        container.appendChild(item);
    });
}

function selectFolderByPath(path) {
    selectedFolderPath = path;
    expandFolderPath(path);
    switchTab('explorer');
    loadFiles();
}
// #endregion

// #region Dual Split Panes
function toggleSplitPane() {
    const pane = document.getElementById("secondaryPane");
    if (!pane) return;

    const isHidden = pane.classList.toggle("hidden");
    const btn = document.getElementById("splitPaneBtn");
    if (btn) btn.textContent = isHidden ? "▥ Split" : "✕ Single";

    if (!isHidden && !secondaryPaneFileName) {
        const mainEditor = document.getElementById("editor");
        if (mainEditor && mainEditor.dataset.filename) {
            openSecondaryPaneFile(mainEditor.dataset.filename);
        }
    }
}

async function openSecondaryPaneFile(name) {
    const database = await getDatabase();
    const tx = database.transaction("files", "readonly");
    const store = tx.objectStore("files");
    const req = store.get(name);

    req.onsuccess = function () {
        const view = document.getElementById("secondaryEditorView");
        const title = document.getElementById("secondaryPaneTitle");
        if (!view) return;

        let rawContent = req.result ? req.result.content : "";
        if (typeof rawContent === "string" && rawContent.startsWith("data:application/octet-stream;base64,")) {
            rawContent = decodeBase64Text(rawContent);
        }

        view.value = rawContent;
        secondaryPaneFileName = name;
        if (title) title.textContent = name;
        
        const secCode = document.getElementById("secondaryHighlightCode");
        if (secCode) secCode.textContent = rawContent;
    };
}
// #endregion

// #region Universal File & Directory Rendering
async function loadFiles() {
    const database = await getDatabase();
    const files = await new Promise((resolve, reject) => {
        const tx = database.transaction("files", "readonly");
        const req = tx.objectStore("files").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error || new Error("Could not read workspace files."));
    });
    const folders = database.objectStoreNames.contains("folders")
        ? await new Promise((resolve, reject) => {
            const tx = database.transaction("folders", "readonly");
            const req = tx.objectStore("folders").getAll();
            req.onsuccess = () => resolve((req.result || []).map(item => item.path).filter(Boolean));
            req.onerror = () => reject(req.error || new Error("Could not read workspace folders."));
        })
        : [];

    const itemCount = document.getElementById("itemCount");
    if (itemCount) itemCount.textContent = `${files.length} files · ${folders.length} folders`;

    const treeRoot = buildFileTreeStructure(files, folders);
    const container = document.getElementById("fileTree");
    if (container) {
        container.innerHTML = "";
        container.classList.add("root-drop-zone");
        container.ondragover = (e) => {
            if (e.target === container) {
                e.preventDefault();
                container.classList.add("drag-over-root");
            }
        };
        container.ondragleave = (e) => {
            if (e.target === container) container.classList.remove("drag-over-root");
        };
        container.ondrop = async (e) => {
            if (e.target !== container) return;
            e.preventDefault();
            container.classList.remove("drag-over-root");
            const payload = readDragPayload(e);
            if (payload.path) await moveWorkspaceItem(payload.path, "", payload.type);
        };

        const rootRow = document.createElement("div");
        rootRow.className = "tree-row workspace-root-row" + (!selectedFolderPath ? " selected-folder" : "");
        rootRow.innerHTML = '<span class="tree-label"><span class="folder-icon">🗂️</span><strong>Workspace Root</strong></span><span class="root-drop-hint">drop here to move out</span>';
        rootRow.addEventListener("click", () => { selectedFolderPath = ""; loadFiles(); });
        rootRow.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); rootRow.classList.add("drag-over"); };
        rootRow.ondragleave = () => rootRow.classList.remove("drag-over");
        rootRow.ondrop = async (e) => {
            e.preventDefault(); e.stopPropagation(); rootRow.classList.remove("drag-over");
            const payload = readDragPayload(e);
            if (payload.path) await moveWorkspaceItem(payload.path, "", payload.type);
        };
        container.appendChild(rootRow);
        renderTree(treeRoot, container, "");
    }
    if (!gitSyncBusy) scheduleGitSyncStatusUpdate();
}

function normalizeWorkspacePath(path) {
    if (typeof path !== "string") return "";
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    const clean = [];
    for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") { clean.pop(); continue; }
        if (part.includes("\0")) continue;
        clean.push(part);
    }
    return clean.join("/");
}

function buildFileTreeStructure(files, folders = []) {
    const root = {};
    const ensureFolderNode = (folderPath) => {
        const parts = normalizeWorkspacePath(folderPath).split('/').filter(Boolean);
        let current = root;
        parts.forEach(part => {
            if (!current[part] || current[part]._isFile) current[part] = { _isFile: false, _children: {} };
            current = current[part]._children;
        });
    };

    folders.forEach(ensureFolderNode);
    files.forEach(file => {
        const normalized = normalizeWorkspacePath(file.name);
        const parts = normalized.split('/').filter(Boolean);
        let current = root;
        parts.forEach((part, index) => {
            if (index === parts.length - 1) {
                current[part] = { _isFile: true, fullPath: normalized };
            } else {
                if (!current[part] || current[part]._isFile) current[part] = { _isFile: false, _children: {} };
                current = current[part]._children;
            }
        });
    });
    return root;
}

function setDragPayload(e, path, type) {
    if (!e.dataTransfer) return;
    const payload = JSON.stringify({ path, type });
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-workspace-item", payload);
    e.dataTransfer.setData("text/plain", path);
}

function readDragPayload(e) {
    try {
        const raw = e.dataTransfer && e.dataTransfer.getData("application/x-workspace-item");
        if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { path: e.dataTransfer ? e.dataTransfer.getData("text/plain") : "", type: "file" };
}

function renderTree(node, container, currentFolderPath) {
    for (const key in node) {
        const item = node[key];
        const treeNode = document.createElement("div");
        treeNode.className = "tree-node";

        if (item._isFile) {
            const ext = key.split('.').pop().toLowerCase();
            let icon = "📄";

            if (["html", "htm", "vue", "svelte", "astro"].includes(ext)) icon = "🌐";
            else if (["css", "scss", "sass", "less"].includes(ext)) icon = "🎨";
            else if (["js", "ts", "jsx", "tsx", "mjs", "cjs", "json"].includes(ext)) icon = "⚡";
            else if (["py", "cpp", "c", "h", "hpp", "cs", "java", "rs", "go", "swift", "kt"].includes(ext)) icon = "⚙️";
            else if (["md", "txt", "log"].includes(ext)) icon = "📝";
            else if (["sql", "db"].includes(ext)) icon = "🗄️";

            const row = document.createElement("div");
            row.className = "tree-row";
            row.draggable = true;
            row.dataset.path = item.fullPath;

            const label = document.createElement("span");
            label.className = "tree-label";
            label.textContent = `${icon} ${key}`;
            label.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                openFile(item.fullPath);
            });

            const actions = document.createElement("span");
            actions.style.display = "flex";
            actions.style.gap = "4px";
            actions.style.alignItems = "center";

            const split = document.createElement("span");
            split.className = "delete-icon";
            split.title = "View in Split Side Pane";
            split.textContent = "▥";
            split.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                openSecondaryPaneFile(item.fullPath);
            });

            const del = document.createElement("span");
            del.className = "delete-icon";
            del.textContent = "✕";
            del.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                deleteFile(item.fullPath);
            });

            const move = document.createElement("span");
            move.className = "delete-icon";
            move.title = "Move File";
            move.textContent = "↪";
            move.addEventListener("click", async (e) => {
                e.preventDefault(); e.stopPropagation();
                await promptMoveWorkspaceItem(item.fullPath, "file");
            });

            actions.appendChild(split);
            actions.appendChild(move);
            actions.appendChild(del);
            row.appendChild(label);
            row.appendChild(actions);
            treeNode.appendChild(row);

            row.ondragstart = (e) => {
                row.classList.add("dragging");
                setDragPayload(e, item.fullPath, "file");
            };
            row.ondragend = () => row.classList.remove("dragging");
        } else {
            const folderPath = currentFolderPath ? `${currentFolderPath}/${key}` : key;
            const childrenContainer = document.createElement("div");
            childrenContainer.className = "tree-children";
            const isExpanded = expandedFolderPaths.has(folderPath);
            childrenContainer.style.display = isExpanded ? "block" : "none";

            const row = document.createElement("div");
            row.className = "tree-row" + (selectedFolderPath === folderPath ? " selected-folder" : "");
            row.dataset.folder = folderPath;
            row.setAttribute("aria-expanded", isExpanded ? "true" : "false");

            const label = document.createElement("span");
            label.className = "tree-label";

            const folderIcon = document.createElement("span");
            folderIcon.className = "folder-icon";
            folderIcon.textContent = isExpanded ? "📂" : "📁";

            const folderName = document.createElement("strong");
            folderName.textContent = key;

            label.appendChild(folderIcon);
            label.appendChild(folderName);

            row.draggable = true;
            row.ondragstart = (e) => {
                e.stopPropagation();
                row.classList.add("dragging");
                setDragPayload(e, folderPath, "folder");
            };
            row.ondragend = () => row.classList.remove("dragging");

            const actions = document.createElement("span");
            actions.style.display = "flex";
            actions.style.gap = "4px";
            actions.style.alignItems = "center";

            const move = document.createElement("span");
            move.className = "delete-icon";
            move.title = "Move Folder";
            move.textContent = "↪";
            move.addEventListener("click", async (e) => {
                e.preventDefault(); e.stopPropagation();
                await promptMoveWorkspaceItem(folderPath, "folder");
            });

            const del = document.createElement("span");
            del.className = "delete-icon";
            del.title = "Delete Folder";
            del.textContent = "🗑️";
            del.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                deleteFolder(folderPath);
            });

            actions.append(move, del);
            row.appendChild(label);
            row.appendChild(actions);
            treeNode.appendChild(row);

            const toggleFolder = (e) => {
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }

                // Some iOS/Safari versions can synthesize a second click after a tap.
                // Ignore an immediate duplicate tap on the same folder.
                const now = Date.now();
                if (lastFolderTapPath === folderPath && (now - lastFolderTapTime) < 350) {
                    return;
                }
                lastFolderTapPath = folderPath;
                lastFolderTapTime = now;

                const opening = childrenContainer.style.display === "none";
                childrenContainer.style.display = opening ? "block" : "none";
                folderIcon.textContent = opening ? "📂" : "📁";
                row.setAttribute("aria-expanded", opening ? "true" : "false");

                if (opening) expandedFolderPaths.add(folderPath);
                else expandedFolderPaths.delete(folderPath);

                selectedFolderPath = folderPath;
                document.querySelectorAll("#fileTree .tree-row.selected-folder").forEach(el => {
                    if (el !== row) el.classList.remove("selected-folder");
                });
                row.classList.add("selected-folder");
            };

            // Toggle in-place. Do NOT call loadFiles() here: rebuilding the tree during
            // the same Safari tap was the cause of the expand/collapse flicker.
            row.addEventListener("click", toggleFolder);

            row.ondragover = (e) => {
                e.preventDefault();
                row.classList.add('drag-over');
            };

            row.ondragleave = () => {
                row.classList.remove('drag-over');
            };

            row.ondrop = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                row.classList.remove('drag-over');
                const payload = readDragPayload(e);
                if (payload.path) {
                    await moveWorkspaceItem(payload.path, folderPath, payload.type);
                }
            };

            renderTree(item._children, childrenContainer, folderPath);
            treeNode.appendChild(childrenContainer);
        }
        container.appendChild(treeNode);
    }
}

function selectFolder(labelElement, folderPath) {
    // Kept as a compatibility shim for old markup/bookmarks. New folder rows toggle
    // directly in renderTree() and never rebuild the tree on a normal folder tap.
    const row = labelElement && labelElement.closest ? labelElement.closest('.tree-row') : null;
    const treeNode = row ? row.parentElement : null;
    const children = treeNode ? treeNode.querySelector(':scope > .tree-children') : null;
    if (!row || !children) return;

    const opening = children.style.display === 'none';
    children.style.display = opening ? 'block' : 'none';
    row.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (opening) expandedFolderPaths.add(folderPath);
    else expandedFolderPaths.delete(folderPath);
    selectedFolderPath = folderPath;
}

function expandFolderPath(path) {
    if (!path) return;
    const parts = path.split('/').filter(Boolean);
    let current = "";
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        expandedFolderPaths.add(current);
    }
}

async function getAllWorkspaceFolders() {
    const database = await getDatabase();
    if (!database.objectStoreNames.contains("folders")) return [];
    return await new Promise((resolve, reject) => {
        const tx = database.transaction("folders", "readonly");
        const req = tx.objectStore("folders").getAll();
        req.onsuccess = () => resolve((req.result || []).map(x => x.path).filter(Boolean));
        req.onerror = () => reject(req.error || new Error("Could not read workspace folders."));
    });
}

async function saveFolderToDb(path) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) return;
    const database = await getDatabase();
    if (!database.objectStoreNames.contains("folders")) throw new Error("Folder storage is unavailable.");
    return await new Promise((resolve, reject) => {
        const tx = database.transaction("folders", "readwrite");
        tx.objectStore("folders").put({ path: normalized });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error(`Could not save folder "${normalized}".`));
        tx.onabort = () => reject(tx.error || new Error(`Saving folder "${normalized}" was aborted.`));
    });
}

async function ensureFolderPath(path) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) return;
    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        await saveFolderToDb(current);
    }
}

async function promptMoveWorkspaceItem(sourcePath, type) {
    const currentParent = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    const target = prompt(`Move ${type} into folder (leave blank for workspace root):`, currentParent);
    if (target === null) return;
    await moveWorkspaceItem(sourcePath, normalizeWorkspacePath(target), type);
}

async function moveWorkspaceItem(sourcePath, targetFolderPath, type = "file") {
    sourcePath = normalizeWorkspacePath(sourcePath);
    targetFolderPath = normalizeWorkspacePath(targetFolderPath || "");
    if (!sourcePath) return;

    const baseName = sourcePath.split('/').pop();
    const newPath = targetFolderPath ? `${targetFolderPath}/${baseName}` : baseName;
    if (sourcePath === newPath) return;
    if (type === "folder" && (targetFolderPath === sourcePath || targetFolderPath.startsWith(sourcePath + "/"))) {
        return alert("A folder cannot be moved inside itself or one of its own subfolders.");
    }

    const [files, folders] = await Promise.all([getAllWorkspaceFiles(), getAllWorkspaceFolders()]);
    const fileNames = new Set(files.map(f => f.name));
    const folderNames = new Set(folders);

    if (type === "file") {
        const item = files.find(f => f.name === sourcePath);
        if (!item) return alert("That file no longer exists.");
        if (folderNames.has(newPath)) return alert(`Cannot move a file onto the existing folder "${newPath}".`);
        if (fileNames.has(newPath) && !confirm(`"${newPath}" already exists. Replace it?`)) return;
        if (targetFolderPath) await ensureFolderPath(targetFolderPath);

        const database = await getDatabase();
        await new Promise((resolve, reject) => {
            const tx = database.transaction("files", "readwrite");
            const store = tx.objectStore("files");
            store.delete(sourcePath);
            store.put({ name: newPath, content: item.content });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error("Could not move file."));
            tx.onabort = () => reject(tx.error || new Error("Move was aborted."));
        });
        workspaceHashCache.delete(sourcePath);
        workspaceHashCache.delete(newPath);
        updateOpenPathAfterMove(sourcePath, newPath, false);
    } else {
        const sourceExists = folderNames.has(sourcePath) || files.some(f => f.name.startsWith(sourcePath + "/"));
        if (!sourceExists) return alert("That folder no longer exists.");
        if (fileNames.has(newPath)) return alert(`Cannot move a folder onto the existing file "${newPath}".`);
        if (folderNames.has(newPath) && !confirm(`"${newPath}" already exists. Merge into it?`)) return;
        if (targetFolderPath) await ensureFolderPath(targetFolderPath);

        const movedFiles = files.filter(f => f.name.startsWith(sourcePath + "/"));
        const movedFolders = folders.filter(f => f === sourcePath || f.startsWith(sourcePath + "/"));
        const database = await getDatabase();
        const stores = database.objectStoreNames.contains("folders") ? ["files", "folders"] : ["files"];
        await new Promise((resolve, reject) => {
            const tx = database.transaction(stores, "readwrite");
            const fileStore = tx.objectStore("files");
            const folderStore = stores.includes("folders") ? tx.objectStore("folders") : null;
            movedFiles.forEach(item => {
                const suffix = item.name.slice(sourcePath.length);
                fileStore.delete(item.name);
                fileStore.put({ name: newPath + suffix, content: item.content });
            });
            if (folderStore) {
                movedFolders.forEach(path => {
                    const suffix = path.slice(sourcePath.length);
                    folderStore.delete(path);
                    folderStore.put({ path: newPath + suffix });
                });
                folderStore.put({ path: newPath });
            }
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error("Could not move folder."));
            tx.onabort = () => reject(tx.error || new Error("Folder move was aborted."));
        });
        movedFiles.forEach(f => { workspaceHashCache.delete(f.name); workspaceHashCache.delete(newPath + f.name.slice(sourcePath.length)); });
        updateOpenPathAfterMove(sourcePath, newPath, true);
        if (selectedFolderPath === sourcePath || selectedFolderPath.startsWith(sourcePath + "/")) {
            selectedFolderPath = newPath + selectedFolderPath.slice(sourcePath.length);
        }
        for (const expandedPath of Array.from(expandedFolderPaths)) {
            if (expandedPath === sourcePath || expandedPath.startsWith(sourcePath + "/")) {
                expandedFolderPaths.delete(expandedPath);
                expandedFolderPaths.add(newPath + expandedPath.slice(sourcePath.length));
            }
        }
    }

    expandFolderPath(targetFolderPath);
    await loadFiles();
}

function updateOpenPathAfterMove(oldPath, newPath, isFolder) {
    const editor = document.getElementById("editor");
    if (editor && editor.dataset.filename) {
        const current = editor.dataset.filename;
        const matches = current === oldPath || (isFolder && current.startsWith(oldPath + "/"));
        if (matches) {
            const updated = isFolder ? newPath + current.slice(oldPath.length) : newPath;
            editor.dataset.filename = updated;
            const label = document.getElementById("activeFileLabel");
            if (label) label.textContent = updated;
            updateBreadcrumbs(updated);
        }
    }
    try {
        window.dispatchEvent(new CustomEvent("workspace:path-moved", { detail: { oldPath, newPath, isFolder } }));
    } catch (_) {}
}
// #endregion

// #region Multi-Format File Import Logic
const uploadInputEl = document.getElementById("uploadInput");
if (uploadInputEl) {
    uploadInputEl.onchange = async function (event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        for (const file of files) {
            if (file.name.toLowerCase().endsWith(".zip")) {
                await unpackZip(file);
            } else {
                await importRegularFile(file);
            }
        }

        loadFiles();
        event.target.value = "";
    };
}

const folderUploadInputEl = document.getElementById("folderUploadInput");
if (folderUploadInputEl) {
    folderUploadInputEl.onchange = async function (event) {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        try {
            for (const file of files) {
                const relative = normalizeWorkspacePath(file.webkitRelativePath || file.name);
                if (!relative) continue;
                const targetPath = normalizeWorkspacePath(selectedFolderPath ? `${selectedFolderPath}/${relative}` : relative);
                const parent = targetPath.includes("/") ? targetPath.slice(0, targetPath.lastIndexOf("/")) : "";
                if (parent) await ensureFolderPath(parent);
                await importRegularFileAtPath(file, targetPath);
            }
            await loadFiles();
        } catch (err) {
            alert("Folder import failed: " + (err.message || err));
        } finally {
            event.target.value = "";
        }
    };
}

async function importRegularFileAtPath(file, destPath) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function () {
            const content = reader.result;
            if (typeof content !== "string" || !isTextContent(content)) {
                const base64Reader = new FileReader();
                base64Reader.onload = function () { saveFileToDb(destPath, base64Reader.result).then(resolve, reject); };
                base64Reader.onerror = reject;
                base64Reader.readAsDataURL(file);
            } else {
                saveFileToDb(destPath, content).then(resolve, reject);
            }
        };
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

async function importRegularFile(file) {
    const destPath = normalizeWorkspacePath(selectedFolderPath ? `${selectedFolderPath}/${file.name}` : file.name);
    const parent = destPath.includes("/") ? destPath.slice(0, destPath.lastIndexOf("/")) : "";
    if (parent) await ensureFolderPath(parent);
    return importRegularFileAtPath(file, destPath);
}

async function saveFileToDb(name, content) {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
        let tx;
        try {
            tx = database.transaction("files", "readwrite");
            tx.objectStore("files").put({ name, content });
        } catch (err) {
            reject(err);
            return;
        }

        tx.oncomplete = () => {
            workspaceHashCache.delete(name);
            resolve();
            if (!gitSyncBusy) scheduleGitSyncStatusUpdate();
        };
        tx.onerror = () => reject(tx.error || new Error(`Could not save "${name}" to the local workspace.`));
        tx.onabort = () => reject(tx.error || new Error(`Saving "${name}" was aborted.`));
    });
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

async function unpackZip(zipFile) {
    try {
        if (typeof JSZip === "undefined") throw new Error("JSZip library not loaded.");

        const buffer = await readFileAsArrayBuffer(zipFile);
        const zip = await JSZip.loadAsync(buffer);
        const extractedFiles = [];

        for (const path in zip.files) {
            const entry = zip.files[path];
            const relativeEntryPath = normalizeWorkspacePath(entry.name);
            if (!relativeEntryPath || relativeEntryPath.startsWith("__MACOSX/")) continue;
            if (entry.dir) {
                const folderPath = normalizeWorkspacePath(selectedFolderPath ? `${selectedFolderPath}/${relativeEntryPath}` : relativeEntryPath);
                if (folderPath) await ensureFolderPath(folderPath);
                continue;
            }

            const normalizedName = entry.name.toLowerCase();
            const isText = EXTENSION_REGEX.test(normalizedName);
            let content;

            if (isText) {
                content = await entry.async("string");
            } else {
                const str = await entry.async("string");
                if (isTextContent(str)) {
                    content = str;
                } else {
                    const base64 = await entry.async("base64");
                    content = "data:application/octet-stream;base64," + base64;
                }
            }

            const relativePath = normalizeWorkspacePath(entry.name);
            if (!relativePath || relativePath.startsWith("__MACOSX/")) continue;
            const targetPath = normalizeWorkspacePath(selectedFolderPath ? `${selectedFolderPath}/${relativePath}` : relativePath);
            const parent = targetPath.includes("/") ? targetPath.slice(0, targetPath.lastIndexOf("/")) : "";
            if (parent) await ensureFolderPath(parent);
            extractedFiles.push({ name: targetPath, content });
        }

        const database = await getDatabase();
        const tx = database.transaction("files", "readwrite");
        const store = tx.objectStore("files");
        for (const item of extractedFiles) {
            store.put(item);
        }

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = (err) => reject(err);
        });

    } catch (err) {
        alert("ZIP unpack error: " + err.message);
    }
}
// #endregion

// #region File Workspace Operations
async function openFile(name) {
    const editor = document.getElementById("editor");
    const currentName = editor?.dataset?.filename || "";
    if (editor && currentName && currentName !== name && isDirty) {
        clearTimeout(autoSaveTimeout);
        await saveFileToDb(currentName, editor.value);
        updateDirtyIndicator(false);
    }

    const database = await getDatabase();

    return await new Promise((resolve, reject) => {
        const tx = database.transaction("files", "readonly");
        const store = tx.objectStore("files");
        const req = store.get(name);

        req.onsuccess = function () {
            const editor = document.getElementById("editor");
            if (!editor) {
                resolve(false);
                return;
            }

            if (!req.result) {
                reject(new Error(`Workspace file not found: ${name}`));
                return;
            }

            let rawContent = req.result.content ?? "";

            if (typeof rawContent === "string" && rawContent.startsWith("data:application/octet-stream;base64,")) {
                rawContent = decodeBase64Text(rawContent);
            }

            editor.value = rawContent;
            editor.dataset.filename = name;
            const label = document.getElementById("activeFileLabel");
            if (label) label.textContent = name;

            lastSearchIndex = 0;
            updateLineNumbers();
            updateHighlights();
            renderCodeBlockNav(rawContent);
            updateBreadcrumbs(name);
            updateDirtyIndicator(false);

            switchTab('editor');

            try {
                window.dispatchEvent(new CustomEvent('workspace:file-opened', { detail: { path: name } }));
            } catch (e) {}

            resolve(true);
        };

        req.onerror = function () {
            reject(req.error || new Error(`Unable to open ${name}`));
        };
    });
}

async function deleteFile(name) {
    if (!confirm(`Delete ${name}?`)) return;
    const database = await getDatabase();
    const tx = database.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.delete(name);
    tx.oncomplete = () => {
        workspaceHashCache.delete(name);
        const editor = document.getElementById("editor");
        if (editor && editor.dataset.filename === name) {
            closeCurrentFile();
        }
        try {
            window.dispatchEvent(new CustomEvent("workspace:file-deleted", { detail: { path: name } }));
        } catch (_) {}
        loadFiles();
    };
}

async function deleteFolder(folderPath) {
    if (!confirm(`Delete folder "${folderPath}" and all contained files?`)) return;
    const [files, folders] = await Promise.all([getAllWorkspaceFiles(), getAllWorkspaceFolders()]);
    const prefix = folderPath + "/";
    const database = await getDatabase();
    const stores = database.objectStoreNames.contains("folders") ? ["files", "folders"] : ["files"];

    await new Promise((resolve, reject) => {
        const tx = database.transaction(stores, "readwrite");
        const fileStore = tx.objectStore("files");
        files.filter(f => f.name.startsWith(prefix)).forEach(f => fileStore.delete(f.name));
        if (stores.includes("folders")) {
            const folderStore = tx.objectStore("folders");
            folders.filter(f => f === folderPath || f.startsWith(prefix)).forEach(f => folderStore.delete(f));
        }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("Could not delete folder."));
        tx.onabort = () => reject(tx.error || new Error("Folder delete was aborted."));
    });

    const editor = document.getElementById("editor");
    if (editor && editor.dataset.filename && editor.dataset.filename.startsWith(prefix)) closeCurrentFile();
    if (selectedFolderPath === folderPath || selectedFolderPath.startsWith(prefix)) selectedFolderPath = "";
    for (const file of files) {
        if (file.name.startsWith(prefix)) workspaceHashCache.delete(file.name);
    }
    for (const expandedPath of Array.from(expandedFolderPaths)) {
        if (expandedPath === folderPath || expandedPath.startsWith(prefix)) expandedFolderPaths.delete(expandedPath);
    }
    try {
        window.dispatchEvent(new CustomEvent("workspace:folder-deleted", { detail: { path: folderPath } }));
    } catch (_) {}
    await loadFiles();
}
// #endregion
