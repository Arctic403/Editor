// #region Global Constants & Variables
const EXTENSION_REGEX = /\.(txt|json|js|mjs|cjs|ts|tsx|jsx|css|scss|sass|less|html|htm|md|xml|cfg|ini|lua|py|cpp|c|h|hpp|cs|java|go|rs|php|rb|sh|bat|ps1|sql|yaml|yml|toml|env|gitignore|properties|log|swift|kt|kts|dart|r|m|mm|vue|svelte|astro|graphql|gql|prisma|diff|patch|dockerfile|makefile)$/i;

let db;
let lastSearchIndex = 0;
let selectedFolderPath = ""; 
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
    initDatabase();
    bindUIEvents();
    bindGitHubEvents();
    initSymbolBar();
    initQuickOpen();
    initThemeSelector();
});

function initDatabase() {
    const request = indexedDB.open("LocalWorkspaceDB", 3);

    request.onupgradeneeded = function (event) {
        db = event.target.result;
        if (!db.objectStoreNames.contains("files")) {
            db.createObjectStore("files", { keyPath: "name" });
        }
    };

    request.onsuccess = function (event) {
        db = event.target.result;
        loadFiles();
        restoreSettings();
    };
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

function filterQuickOpenFiles(query) {
    if (!db) return;
    const container = document.getElementById("quickOpenResults");
    if (!container) return;

    const tx = db.transaction("files", "readonly");
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
function bindGitHubEvents() {
    bindClick("connectGhBtn", function() {
        const token = document.getElementById("tokenInput").value.trim();
        if (!token) return alert("Please enter a valid GitHub PAT first.");
        fetchGitHubRepos(token);
    });

    const repoSelect = document.getElementById("repoSelect");
    if (repoSelect) {
        repoSelect.addEventListener("change", function() {
            const selectedRepo = this.value;
            localStorage.setItem("gh_repo", selectedRepo);
            if (selectedRepo) {
                const token = document.getElementById("tokenInput").value.trim();
                fetchGitHubBranches(token, selectedRepo);
                if (confirm(`Fetch and import files from repository "${selectedRepo}" into your local workspace?`)) {
                    importRepoFromGitHub(token, selectedRepo);
                }
            }
        });
    }

    const branchSelect = document.getElementById("branchSelect");
    if (branchSelect) {
        branchSelect.addEventListener("change", function() {
            localStorage.setItem("gh_branch", this.value);
        });
    }
}

async function fetchGitHubRepos(token) {
    const repoSelect = document.getElementById("repoSelect");
    if (!repoSelect) return;
    repoSelect.innerHTML = '<option value="">Loading repositories...</option>';

    try {
        const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github.v3+json"
            }
        });

        if (!res.ok) throw new Error("Authentication failed or invalid token.");

        const repos = await res.json();
        repoSelect.innerHTML = '<option value="">-- Choose Repository --</option>';

        const savedRepo = localStorage.getItem("gh_repo");
        repos.forEach(repo => {
            const opt = document.createElement("option");
            opt.value = repo.full_name;
            opt.textContent = repo.full_name;
            if (savedRepo && repo.full_name === savedRepo) opt.selected = true;
            repoSelect.appendChild(opt);
        });

        if (savedRepo) {
            fetchGitHubBranches(token, savedRepo);
        }
    } catch (err) {
        repoSelect.innerHTML = '<option value="">Failed to load repos</option>';
        alert("GitHub API Error: " + err.message);
    }
}

async function fetchGitHubBranches(token, repo) {
    const branchSelect = document.getElementById("branchSelect");
    if (!branchSelect) return;
    branchSelect.innerHTML = '<option value="">Loading branches...</option>';

    try {
        const res = await fetch(`https://api.github.com/repos/${repo}/branches`, {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github.v3+json"
            }
        });

        if (!res.ok) throw new Error("Could not fetch branches.");

        const branches = await res.json();
        branchSelect.innerHTML = '';

        const savedBranch = localStorage.getItem("gh_branch");
        branches.forEach(branch => {
            const opt = document.createElement("option");
            opt.value = branch.name;
            opt.textContent = branch.name;
            if ((savedBranch && branch.name === savedBranch) || (!savedBranch && (branch.name === "main" || branch.name === "master"))) {
                opt.selected = true;
            }
            branchSelect.appendChild(opt);
        });
    } catch (err) {
        branchSelect.innerHTML = '<option value="">Failed to load branches</option>';
    }
}

async function importRepoFromGitHub(token, repo) {
    const branchSelect = document.getElementById("branchSelect");
    const branch = (branchSelect && branchSelect.value) ? branchSelect.value : "main";
    try {
        const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github.v3+json"
            }
        });

        if (!res.ok) throw new Error("Unable to fetch repository file tree.");

        const data = await res.json();
        const filesToFetch = data.tree.filter(item => item.type === "blob");

        let imported = 0;
        for (const file of filesToFetch) {
            const fileRes = await fetch(file.url, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Accept": "application/vnd.github.v3.raw"
                }
            });

            if (fileRes.ok) {
                const text = await fileRes.text();
                await saveFileToDb(file.path, text);
                imported++;
            }
        }

        loadFiles();
        alert(`Successfully imported ${imported} file(s) from GitHub!`);
    } catch (err) {
        alert("Repository Import Failed: " + err.message);
    }
}

async function pushFileToGitHub(name, content, token, repo, branch) {
    const url = `https://api.github.com/repos/${repo}/contents/${name}`;
    const headers = {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/vnd.github.v3+json"
    };

    let sha = null;
    try {
        const getRes = await fetch(`${url}?ref=${branch}`, { headers });
        if (getRes.ok) {
            const fileData = await getRes.json();
            sha = fileData.sha;
        }
    } catch (e) {}

    // FileReader Base64 conversion prevents Stack Overflow call limits on large files
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const base64Content = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result;
            resolve(result.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });

    const body = {
        message: `Update ${name} via Mobile Workspace`,
        content: base64Content,
        branch: branch,
        ...(sha && { sha })
    };

    const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
    if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || res.status);
    }
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
        if (!db) return;

        const tx = db.transaction("files", "readonly");
        const store = tx.objectStore("files");
        const req = store.getAll();

        req.onsuccess = async function () {
            const files = req.result;
            if (files.length === 0) return alert("No files to export.");

            const zip = new JSZip();
            files.forEach(file => zip.file(file.name, file.content));

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

        const tx = db.transaction("files", "readonly");
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

function openSecondaryPaneFile(name) {
    if (!db) return;
    const tx = db.transaction("files", "readonly");
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
function loadFiles() {
    if (!db) return;
    const tx = db.transaction("files", "readonly");
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
            childrenContainer.style.display = "none";

            const isSelected = selectedFolderPath === folderPath;

            treeNode.innerHTML = `
                <div class="tree-row ${isSelected ? 'selected-folder' : ''}" data-folder="${folderPath}">
                    <span class="tree-label" onclick="selectFolder(this, '${folderPath}')">📁 <strong>${key}</strong></span>
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
    if (selectedFolderPath === folderPath) {
        selectedFolderPath = "";
    } else {
        selectedFolderPath = folderPath;
    }
    toggleFolder(labelElement);
    loadFiles();
}

function toggleFolder(labelElement) {
    const rowElement = labelElement.parentElement;
    const children = rowElement.nextElementSibling;
    if (children) {
        const isHidden = children.style.display === "none";
        children.style.display = isHidden ? "block" : "none";
        labelElement.innerHTML = labelElement.innerHTML.replace(isHidden ? "📁" : "📂", isHidden ? "📂" : "📁");
    }
}

async function moveFileToFolder(filePath, targetFolderPath) {
    const fileName = filePath.split('/').pop();
    const newPath = `${targetFolderPath}/${fileName}`;
    if (filePath === newPath) return;

    const tx = db.transaction("files", "readwrite");
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

function saveFileToDb(name, content) {
    return new Promise((resolve) => {
        const tx = db.transaction("files", "readwrite");
        const store = tx.objectStore("files");
        store.put({ name, content });
        tx.oncomplete = resolve;
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

        const tx = db.transaction("files", "readwrite");
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
function openFile(name) {
    const tx = db.transaction("files", "readonly");
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

function deleteFile(name) {
    if (!confirm(`Delete ${name}?`)) return;
    const tx = db.transaction("files", "readwrite");
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

function deleteFolder(folderPath) {
    if (!confirm(`Delete folder "${folderPath}" and all contained files?`)) return;

    const tx = db.transaction("files", "readwrite");
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
            if (selectedFolderPath === folderPath) selectedFolderPath = "";
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
