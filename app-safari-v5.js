// #region Global Constants & Variables
const EXTENSION_REGEX = /\.(txt|json|js|mjs|cjs|ts|tsx|jsx|css|scss|sass|less|html|htm|md|xml|cfg|ini|lua|py|cpp|c|h|hpp|cs|java|go|rs|php|rb|sh|bat|ps1|sql|yaml|yml|toml|env|gitignore|properties|log|swift|kt|kts|dart|r|m|mm|vue|svelte|astro|graphql|gql|prisma|diff|patch|dockerfile|makefile)$/i;

let db;
let dbReadyPromise = null;
const BUILD_ID = "SafariSafe-v5-FolderTree-20260820";
const WORKSPACE_DB_NAME = "MobileWorkspaceDB_SafariSafe_v4";
const WORKSPACE_DB_VERSION = 1;
const APP_BUILD = "2026-08-20-safari-v3";
console.info("Mobile Workspace build:", APP_BUILD);
let lastSearchIndex = 0;
let selectedFolderPath = "";
const expandedFolderPaths = new Set();
let secondaryPaneFileName = ""; 
let isDirty = false; 
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

function workspaceContentToGitHubBase64(content) {
    if (typeof content === "string") {
        const match = content.match(/^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/);
        if (match) return match[2].replace(/\s/g, "");
    }

    const bytes = new TextEncoder().encode(content == null ? "" : String(content));
    return bytesToBase64(bytes);
}

function setPullButtonState(isBusy, label) {
    const btn = document.getElementById("pullGitHubBtn");
    if (!btn) return;
    btn.disabled = isBusy;
    btn.textContent = label || (isBusy ? "⬇️ Pulling..." : "⬇️ Pull Repo");
}

function bindGitHubEvents() {
    bindClick("connectGhBtn", async function() {
        const token = document.getElementById("tokenInput").value.trim();
        if (!token) return alert("Please enter a valid GitHub PAT first.");
        await fetchGitHubRepos(token);
    });

    const repoSelect = document.getElementById("repoSelect");
    if (repoSelect) {
        repoSelect.addEventListener("change", async function() {
            const selectedRepo = this.value;
            localStorage.setItem("gh_repo", selectedRepo);

            const branchSelect = document.getElementById("branchSelect");
            if (!selectedRepo) {
                if (branchSelect) branchSelect.innerHTML = '<option value="">-- Choose Branch --</option>';
                return;
            }

            const token = document.getElementById("tokenInput").value.trim();
            if (!token) return alert("Please enter your GitHub PAT first.");

            const selectedOption = this.options[this.selectedIndex];
            const defaultBranch = selectedOption ? selectedOption.dataset.defaultBranch || "" : "";
            await fetchGitHubBranches(token, selectedRepo, defaultBranch);
        });
    }

    const branchSelect = document.getElementById("branchSelect");
    if (branchSelect) {
        branchSelect.addEventListener("change", function() {
            localStorage.setItem("gh_branch", this.value);
        });
    }

    bindClick("pullGitHubBtn", async function() {
        const token = document.getElementById("tokenInput")?.value.trim() || "";
        const repo = document.getElementById("repoSelect")?.value || "";
        const branch = document.getElementById("branchSelect")?.value || "";

        if (!token) return alert("Enter your GitHub PAT first.");
        if (!repo) return alert("Choose a GitHub repository first.");
        if (!branch) return alert("Choose a branch first.");

        if (!confirm(`Pull "${repo}" (${branch}) into this workspace? Files with the same paths will be overwritten locally.`)) return;

        setPullButtonState(true);
        try {
            await importRepoFromGitHub(token, repo, branch);
        } finally {
            setPullButtonState(false);
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
        branchSelect.innerHTML = '';

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
        return branches;
    } catch (err) {
        branchSelect.innerHTML = '<option value="">Failed to load branches</option>';
        alert("GitHub Branch Error: " + err.message);
        return [];
    } finally {
        branchSelect.disabled = false;
    }
}

async function importRepoFromGitHub(token, repo, branch) {
    // Open/validate local storage before downloading repository blobs.
    await getDatabase();
    const branchSelect = document.getElementById("branchSelect");
    const selectedOption = branchSelect?.options[branchSelect.selectedIndex];
    let commitSha = selectedOption?.dataset.commitSha || "";

    try {
        const repoPath = githubRepoApiPath(repo);

        // If branch metadata is unavailable/stale, resolve the selected branch again first.
        if (!commitSha) {
            const branchRes = await fetch(`https://api.github.com/repos/${repoPath}/branches/${encodeURIComponent(branch)}`, {
                headers: githubHeaders(token)
            });
            if (!branchRes.ok) throw new Error(await getGitHubError(branchRes, `Could not resolve branch "${branch}"`));
            const branchData = await branchRes.json();
            commitSha = branchData.commit?.sha || "";
        }

        if (!commitSha) throw new Error(`GitHub did not return a commit for branch "${branch}".`);

        // Resolve commit -> tree SHA. This avoids branch-name/path issues (for example feature/foo).
        const commitRes = await fetch(`https://api.github.com/repos/${repoPath}/git/commits/${encodeURIComponent(commitSha)}`, {
            headers: githubHeaders(token)
        });
        if (!commitRes.ok) throw new Error(await getGitHubError(commitRes, "Could not resolve the branch commit"));
        const commitData = await commitRes.json();
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
        if (!filesToFetch.length) {
            loadFiles();
            alert(`Branch "${branch}" contains no files to import.`);
            return;
        }

        let imported = 0;
        const failed = [];

        for (const file of filesToFetch) {
            setPullButtonState(true, `⬇️ Pulling ${imported + 1}/${filesToFetch.length}`);
            try {
                const fileRes = await fetch(file.url, {
                    headers: githubHeaders(token)
                });

                if (!fileRes.ok) {
                    failed.push(`${file.path} (HTTP ${fileRes.status})`);
                    continue;
                }

                const blobData = await fileRes.json();
                if (blobData.encoding !== "base64" || typeof blobData.content !== "string") {
                    failed.push(`${file.path} (unsupported blob response)`);
                    continue;
                }

                const content = decodeGitHubBlob(blobData.content, file.path);
                await saveFileToDb(file.path, content);
                imported++;
            } catch (fileErr) {
                console.error("GitHub pull failed for", file.path, fileErr);
                failed.push(`${file.path} (${fileErr.message})`);
            }
        }

        loadFiles();
        if (failed.length) {
            const preview = failed.slice(0, 8).join("\n");
            alert(`Pulled ${imported} of ${filesToFetch.length} file(s) from ${repo} (${branch}).\n\nFailed:\n${preview}${failed.length > 8 ? `\n...and ${failed.length - 8} more` : ""}`);
        } else {
            alert(`Successfully pulled ${imported} file(s) from ${repo} (${branch})!`);
        }
    } catch (err) {
        alert("Repository Pull Failed: " + err.message);
    }
}

async function pushFileToGitHub(name, content, token, repo, branch) {
    if (!branch) throw new Error("Choose a GitHub branch first.");

    const repoPath = githubRepoApiPath(repo);
    const encodedPath = name.split("/").map(part => encodeURIComponent(part)).join("/");
    const url = `https://api.github.com/repos/${repoPath}/contents/${encodedPath}`;
    const headers = githubHeaders(token, { "Content-Type": "application/json" });

    let sha = null;
    const getRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) {
        const fileData = await getRes.json();
        sha = fileData.sha;
    } else if (getRes.status !== 404) {
        throw new Error(await getGitHubError(getRes, `Could not check existing GitHub file "${name}"`));
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

    return putRes.json();
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

    bindClick("closeFileBtn", function () {
        if (!editor) return;
        editor.value = "";
        editor.dataset.filename = "";
        const label = document.getElementById("activeFileLabel");
        if (label) label.textContent = "No file selected";
        updateLineNumbers();
        updateHighlights();
        renderCodeBlockNav("");
        updateBreadcrumbs("");
        updateDirtyIndicator(false);
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
        const database = await getDatabase();

        const tx = database.transaction("files", "readonly");
        const store = tx.objectStore("files");
        const req = store.getAll();

        req.onsuccess = async function () {
            const files = req.result;
            if (files.length === 0) return alert("No files to export.");

            const zip = new JSZip();
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
            URL.revokeObjectURL(link.href);
        };
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
        const name = prompt("Enter file path:", defaultPath);
        if (!name || name.trim() === "" || name.endsWith("/")) return;

        saveFileToDb(name.trim(), "").then(() => {
            loadFiles();
            openFile(name.trim());
        });
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

        try {
            await pushFileToGitHub(name, content, token, repo, branch);
            alert(`Pushed ${name} successfully!`);
        } catch (err) {
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
        const database = await getDatabase();

        const tx = database.transaction("files", "readonly");
        const store = tx.objectStore("files");
        const req = store.getAll();

        req.onsuccess = async function () {
            const files = req.result;
            if (files.length === 0) return alert("No files to push.");

            let success = 0;
            for (const file of files) {
                try {
                    await pushFileToGitHub(file.name, file.content, token, repo, branch);
                    success++;
                } catch (err) {
                    console.error(err);
                }
            }
            alert(`Pushed ${success} of ${files.length} files!`);
        };
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
    rootItem.onclick = () => loadFiles();
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
    const tx = database.transaction("files", "readonly");
    const store = tx.objectStore("files");
    const req = store.getAll();

    req.onsuccess = function () {
        const files = req.result;
        const itemCount = document.getElementById("itemCount");
        if (itemCount) itemCount.textContent = `${files.length} items`;
        
        const treeRoot = buildFileTreeStructure(files);
        const container = document.getElementById("fileTree");
        if (container) {
            container.innerHTML = "";
            renderTree(treeRoot, container, "");
        }
    };
}

function buildFileTreeStructure(files) {
    const root = {};
    files.forEach(file => {
        const parts = file.name.split('/');
        let current = root;
        parts.forEach((part, index) => {
            if (index === parts.length - 1) {
                current[part] = { _isFile: true, fullPath: file.name };
            } else {
                if (!current[part]) current[part] = { _isFile: false, _children: {} };
                current = current[part]._children;
            }
        });
    });
    return root;
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

            treeNode.innerHTML = `
                <div class="tree-row" draggable="true" data-path="${item.fullPath}">
                    <span class="tree-label" onclick="openFile('${item.fullPath}')">${icon} ${key}</span>
                    <span style="display:flex; gap:4px; align-items:center;">
                        <span class="delete-icon" title="View in Split Side Pane" onclick="openSecondaryPaneFile('${item.fullPath}')">▥</span>
                        <span class="delete-icon" onclick="deleteFile('${item.fullPath}')">✕</span>
                    </span>
                </div>
            `;

            const row = treeNode.querySelector('.tree-row');
            row.ondragstart = (e) => {
                e.dataTransfer.setData("text/plain", item.fullPath);
            };
        } else {
            const folderPath = currentFolderPath ? `${currentFolderPath}/${key}` : key;
            const childrenContainer = document.createElement("div");
            childrenContainer.className = "tree-children";
            const isExpanded = expandedFolderPaths.has(folderPath);
            childrenContainer.style.display = isExpanded ? "block" : "none";

            const isSelected = selectedFolderPath === folderPath;

            treeNode.innerHTML = `
                <div class="tree-row ${isSelected ? 'selected-folder' : ''}" data-folder="${folderPath}">
                    <span class="tree-label" onclick="selectFolder(this, '${folderPath}')">${isExpanded ? '📂' : '📁'} <strong>${key}</strong></span>
                    <span class="delete-icon" title="Delete Folder" onclick="deleteFolder('${folderPath}')">🗑️</span>
                </div>
            `;

            const row = treeNode.querySelector('.tree-row');

            row.ondragover = (e) => {
                e.preventDefault();
                row.classList.add('drag-over');
            };

            row.ondragleave = () => {
                row.classList.remove('drag-over');
            };

            row.ondrop = async (e) => {
                e.preventDefault();
                row.classList.remove('drag-over');
                const sourcePath = e.dataTransfer.getData("text/plain");
                if (sourcePath) {
                    await moveFileToFolder(sourcePath, folderPath);
                }
            };

            renderTree(item._children, childrenContainer, folderPath);
            treeNode.appendChild(childrenContainer);
        }
        container.appendChild(treeNode);
    }
}

function selectFolder(labelElement, folderPath) {
    // Keep expansion state separate from selection state. The tree is rebuilt by
    // loadFiles(), so DOM-only toggling would immediately be lost after rerender.
    if (expandedFolderPaths.has(folderPath)) {
        expandedFolderPaths.delete(folderPath);
    } else {
        expandedFolderPaths.add(folderPath);
    }

    selectedFolderPath = folderPath;
    loadFiles();
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

async function moveFileToFolder(filePath, targetFolderPath) {
    const fileName = filePath.split('/').pop();
    const newPath = `${targetFolderPath}/${fileName}`;
    if (filePath === newPath) return;

    const database = await getDatabase();
    const tx = database.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    const req = store.get(filePath);

    req.onsuccess = function() {
        if (req.result) {
            const content = req.result.content;
            store.delete(filePath);
            store.put({ name: newPath, content });
        }
    };

    tx.oncomplete = () => {
        const editor = document.getElementById("editor");
        if (editor && editor.dataset.filename === filePath) {
            editor.dataset.filename = newPath;
            const label = document.getElementById("activeFileLabel");
            if (label) label.textContent = "Editing: " + newPath;
            updateBreadcrumbs(newPath);
        }
        loadFiles();
    };
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

async function importRegularFile(file) {
    const destPath = selectedFolderPath ? `${selectedFolderPath}/${file.name}` : file.name;
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function () {
            let content = reader.result;
            if (typeof content !== "string" || !isTextContent(content)) {
                const base64Reader = new FileReader();
                base64Reader.onload = function () {
                    saveFileToDb(destPath, base64Reader.result).then(resolve);
                };
                base64Reader.readAsDataURL(file);
            } else {
                saveFileToDb(destPath, content).then(resolve);
            }
        };
        reader.onerror = reject;
        reader.readAsText(file);
    });
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

        tx.oncomplete = () => resolve();
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
            if (entry.dir) continue;

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

            const targetPath = selectedFolderPath ? `${selectedFolderPath}/${entry.name}` : entry.name;
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
    const database = await getDatabase();
    const tx = database.transaction("files", "readonly");
    const store = tx.objectStore("files");
    const req = store.get(name);

    req.onsuccess = function () {
        const editor = document.getElementById("editor");
        if (!editor) return;

        let rawContent = req.result ? req.result.content : "";

        if (typeof rawContent === "string" && rawContent.startsWith("data:application/octet-stream;base64,")) {
            rawContent = decodeBase64Text(rawContent);
        }

        editor.value = rawContent;
        editor.dataset.filename = name;
        const label = document.getElementById("activeFileLabel");
        if (label) label.textContent = "Editing: " + name;

        lastSearchIndex = 0;
        updateLineNumbers();
        updateHighlights();
        renderCodeBlockNav(rawContent);
        updateBreadcrumbs(name);
        updateDirtyIndicator(false);

        switchTab('editor');
    };
}

async function deleteFile(name) {
    if (!confirm(`Delete ${name}?`)) return;
    const database = await getDatabase();
    const tx = database.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.delete(name);
    tx.oncomplete = () => {
        const editor = document.getElementById("editor");
        if (editor && editor.dataset.filename === name) {
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
        loadFiles();
    };
}

async function deleteFolder(folderPath) {
    if (!confirm(`Delete folder "${folderPath}" and all contained files?`)) return;

    const database = await getDatabase();
    const tx = database.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    const req = store.getAllKeys();

    req.onsuccess = function () {
        const keys = req.result;
        const prefix = folderPath + "/";
        const editor = document.getElementById("editor");

        keys.forEach(key => {
            if (key === folderPath || key.startsWith(prefix)) {
                store.delete(key);
                if (editor && editor.dataset.filename === key) {
                    editor.value = "";
                    editor.dataset.filename = "";
                    const label = document.getElementById("activeFileLabel");
                    if (label) label.textContent = "No file selected";
                }
            }
        });

        tx.oncomplete = () => {
            if (selectedFolderPath === folderPath || selectedFolderPath.startsWith(prefix)) selectedFolderPath = "";
            for (const expandedPath of Array.from(expandedFolderPaths)) {
                if (expandedPath === folderPath || expandedPath.startsWith(prefix)) {
                    expandedFolderPaths.delete(expandedPath);
                }
            }
            updateLineNumbers();
            updateHighlights();
            renderCodeBlockNav("");
            updateBreadcrumbs("");
            updateDirtyIndicator(false);
            loadFiles();
        };
    };
}
// #endregion
