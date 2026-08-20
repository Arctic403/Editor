// #region Global Constants & Variables
// Universal Text File Identifier (Matches over 50+ common code/data extensions)
const EXTENSION_REGEX = /\.(txt|json|js|mjs|cjs|ts|tsx|jsx|css|scss|sass|less|html|htm|md|xml|cfg|ini|lua|py|cpp|c|h|hpp|cs|java|go|rs|php|rb|sh|bat|ps1|sql|yaml|yml|toml|env|gitignore|properties|log|swift|kt|kts|dart|r|m|mm|vue|svelte|astro|graphql|gql|prisma|diff|patch|dockerfile|makefile)$/i;

let db;
let lastSearchIndex = 0;
// #endregion

// #region Helper Utilities
// Safe Event Listener Binding (iOS Safari + Chrome Mobile Compatible)
function bindClick(id, handler) {
    const element = document.getElementById(id);
    if (element) {
        element.addEventListener("click", handler);
        element.addEventListener("touchend", function (e) {
            e.preventDefault();
            handler(e);
        }, { passive: false });
    }
}

// Check if raw file data contains standard printable text
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

// Decode Base64 Strings Back to Plain Text
function decodeBase64Text(base64Str) {
    try {
        const cleanBase64 = base64Str.replace(/^data:application\/octet-stream;base64,/, "");
        const binaryString = atob(cleanBase64);
        if (isTextContent(binaryString)) {
            return binaryString;
        }
    } catch (e) {
        // Return original if decoding fails
    }
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
// #endregion

// #region Application Initialization
document.addEventListener("DOMContentLoaded", function () {
    initDatabase();
    bindUIEvents();
    bindGitHubEvents();
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
    const token = localStorage.getItem("gh_token") || "";
    document.getElementById("tokenInput").value = token;
    
    if (token) {
        fetchGitHubRepos(token);
    }
}

document.getElementById("tokenInput").addEventListener("input", e => localStorage.setItem("gh_token", e.target.value.trim()));
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
    const branch = document.getElementById("branchSelect").value || "main";
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

    const bytes = new TextEncoder().encode(content);
    const base64Content = btoa(String.fromCharCode(...bytes));

    const body = {
        message: `Update ${name} via Mobile Editor`,
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
    const lineHeight = 20; // Matches editor CSS line-height
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

    // Sync input changes across Line Numbers, Background Highlights, Block Nav & Auto-Save
    editor.addEventListener("input", function () {
        updateLineNumbers();
        updateHighlights();
        renderCodeBlockNav(this.value);
        autoSaveCurrentFile();
    });

    // Code Editor Shortcuts: Support Tab indentation & Save hotkey
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
        }

        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            saveCurrentFile();
        }
    });

    // Sync horizontal/vertical scrolling across all three layers
    editor.addEventListener("scroll", function () {
        lineNumbers.scrollTop = editor.scrollTop;
        if (highlightLayer) {
            highlightLayer.scrollTop = editor.scrollTop;
            highlightLayer.scrollLeft = editor.scrollLeft;
        }
    });

    // Live update search highlights as you type in search field
    if (searchInput) {
        searchInput.addEventListener("input", updateHighlights);
    }

    bindClick("closeFileBtn", function () {
        editor.value = "";
        editor.dataset.filename = "";
        document.getElementById("activeFileLabel").textContent = "No file selected";
        updateLineNumbers();
        updateHighlights();
        renderCodeBlockNav("");
    });

    bindClick("searchToggleBtn", function () {
        const bar = document.getElementById("searchReplaceBar");
        bar.classList.toggle("hidden");
        updateHighlights();
    });

    bindClick("fullscreenBtn", function () {
        const appContainer = document.getElementById("appContainer");
        const isFullscreen = appContainer.classList.toggle("fullscreen");
        document.getElementById("fullscreenBtn").textContent = isFullscreen ? "⛶ Exit" : "⛶ Fullscreen";
    });

    // WORKING FIND & HIGHLIGHT FUNCTIONALITY
    bindClick("findNextBtn", function () {
        const searchVal = document.getElementById("searchInput").value;
        if (!searchVal) return alert("Enter text to find.");

        const text = editor.value;
        const lowerText = text.toLowerCase();
        const lowerSearch = searchVal.toLowerCase();

        let index = lowerText.indexOf(lowerSearch, lastSearchIndex);

        if (index === -1) {
            index = lowerText.indexOf(lowerSearch, 0); // Loop back to start
        }

        if (index !== -1) {
            editor.focus();
            
            // Set text range selection (Highlights text cursor position)
            editor.setSelectionRange(index, index + searchVal.length);
            lastSearchIndex = index + searchVal.length;

            // Scroll editor view directly to match location
            const linesBefore = text.substring(0, index).split("\n").length;
            const lineHeight = 20; // Approximate line height in px
            editor.scrollTop = (linesBefore - 2) * lineHeight;
            
            updateHighlights();
        } else {
            alert(`No matches found for "${searchVal}".`);
            lastSearchIndex = 0;
        }
    });

    // REPLACE SINGLE
    bindClick("replaceBtn", function () {
        const searchVal = document.getElementById("searchInput").value;
        const replaceVal = document.getElementById("replaceInput").value;

        if (!searchVal) return alert("Enter text to find.");

        const text = editor.value;
        if (!text.includes(searchVal)) {
            return alert(`Text "${searchVal}" not found.`);
        }

        if (confirm(`Replace next instance of "${searchVal}" with "${replaceVal}"?`)) {
            editor.value = text.replace(searchVal, replaceVal);
            updateLineNumbers();
            updateHighlights();
            renderCodeBlockNav(editor.value);
            autoSaveCurrentFile();
        }
    });

    // REPLACE ALL
    bindClick("replaceAllBtn", function () {
        const searchVal = document.getElementById("searchInput").value;
        const replaceVal = document.getElementById("replaceInput").value;

        if (!searchVal) return alert("Enter text to find.");

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
            autoSaveCurrentFile();
            alert(`Replaced ${matches} instance(s).`);
        }
    });

    bindClick("saveLocalBtn", function () {
        saveCurrentFile(true);
    });

    bindClick("newFileBtn", function () {
        const name = prompt("Enter file path (e.g., src/components/App.tsx):");
        if (!name) return;

        saveFileToDb(name, "").then(() => {
            loadFiles();
            openFile(name);
        });
    });

    bindClick("pushGitHubBtn", async function () {
        const token = document.getElementById("tokenInput").value.trim();
        const repo = document.getElementById("repoSelect").value;
        const branch = document.getElementById("branchSelect").value;
        const name = editor.dataset.filename;
        const content = editor.value;

        if (!token || !repo || !name) return alert("Select a file & specify GitHub credentials.");

        try {
            await pushFileToGitHub(name, content, token, repo, branch);
            alert(`Pushed ${name} successfully!`);
        } catch (err) {
            alert("Push failed: " + err.message);
        }
    });

    bindClick("pushAllGitHubBtn", async function () {
        const token = document.getElementById("tokenInput").value.trim();
        const repo = document.getElementById("repoSelect").value;
        const branch = document.getElementById("branchSelect").value;

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
    const name = editor.dataset.filename;
    if (!name) {
        if (showAlert) alert("Select a file first.");
        return;
    }

    saveFileToDb(name, editor.value).then(() => {
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
    const lines = editor.value.split("\n").length;
    let numbersArr = [];
    for (let i = 1; i <= lines; i++) {
        numbersArr.push(i);
    }
    lineNumbers.textContent = numbersArr.join("\n");
}

function updateHighlights() {
    const editor = document.getElementById("editor");
    const highlightLayer = document.getElementById("highlightLayer");
    const searchInput = document.getElementById("searchInput");
    const searchBar = document.getElementById("searchReplaceBar");

    if (!highlightLayer) return;

    let text = editor.value;
    
    // Trailing newline check so editor cursor vertical align matches exact height
    if (text.endsWith("\n")) {
        text += " ";
    }

    const searchVal = searchInput ? searchInput.value : "";
    
    // Hide highlights if search bar is hidden or query empty
    if (!searchVal || (searchBar && searchBar.classList.contains("hidden"))) {
        highlightLayer.innerHTML = escapeHtml(text);
        return;
    }

    const escapedText = escapeHtml(text);
    const escapedSearch = escapeHtml(searchVal);
    const regex = new RegExp(`(${escapeRegExp(escapedSearch)})`, "gi");

    highlightLayer.innerHTML = escapedText.replace(regex, `<mark class="search-highlight">$1</mark>`);
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
        document.getElementById("itemCount").textContent = `${files.length} items`;
        
        const treeRoot = buildFileTreeStructure(files);
        const container = document.getElementById("fileTree");
        container.innerHTML = "";
        renderTree(treeRoot, container, "");
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
                <div class="tree-row">
                    <span class="tree-label" onclick="openFile('${item.fullPath}')">${icon} ${key}</span>
                    <span class="delete-icon" onclick="deleteFile('${item.fullPath}')">✕</span>
                </div>
            `;
        } else {
            const folderPath = currentFolderPath ? `${currentFolderPath}/${key}` : key;
            const childrenContainer = document.createElement("div");
            childrenContainer.className = "tree-children";
            childrenContainer.style.display = "none";

            treeNode.innerHTML = `
                <div class="tree-row">
                    <span class="tree-label" onclick="toggleFolder(this)">📁 <strong>${key}</strong></span>
                    <span class="delete-icon" title="Delete Folder" onclick="deleteFolder('${folderPath}')">🗑️</span>
                </div>
            `;
            renderTree(item._children, childrenContainer, folderPath);
            treeNode.appendChild(childrenContainer);
        }
        container.appendChild(treeNode);
    }
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
// #endregion

// #region Multi-Format File Import Logic
document.getElementById("uploadInput").onchange = async function (event) {
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

async function importRegularFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function () {
            let content = reader.result;
            if (typeof content !== "string" || !isTextContent(content)) {
                const base64Reader = new FileReader();
                base64Reader.onload = function () {
                    saveFileToDb(file.name, base64Reader.result).then(resolve);
                };
                base64Reader.readAsDataURL(file);
            } else {
                saveFileToDb(file.name, content).then(resolve);
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

            extractedFiles.push({ name: entry.name, content });
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
        let rawContent = req.result ? req.result.content : "";

        if (typeof rawContent === "string" && rawContent.startsWith("data:application/octet-stream;base64,")) {
            rawContent = decodeBase64Text(rawContent);
        }

        editor.value = rawContent;
        editor.dataset.filename = name;
        document.getElementById("activeFileLabel").textContent = "Editing: " + name;
        lastSearchIndex = 0;
        updateLineNumbers();
        updateHighlights();
        renderCodeBlockNav(rawContent);
    };
}

function deleteFile(name) {
    if (!confirm(`Delete ${name}?`)) return;
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.delete(name);
    tx.oncomplete = () => {
        const editor = document.getElementById("editor");
        if (editor.dataset.filename === name) {
            editor.value = "";
            editor.dataset.filename = "";
            document.getElementById("activeFileLabel").textContent = "No file selected";
            updateLineNumbers();
            updateHighlights();
            renderCodeBlockNav("");
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
                if (editor.dataset.filename === key) {
                    editor.value = "";
                    editor.dataset.filename = "";
                    document.getElementById("activeFileLabel").textContent = "No file selected";
                }
            }
        });

        tx.oncomplete = () => {
            updateLineNumbers();
            updateHighlights();
            renderCodeBlockNav("");
            loadFiles();
        };
    };
}
// #endregion
