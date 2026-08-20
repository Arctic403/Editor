// Universal Text File Identifier (Matches over 50+ common code/data extensions)
const EXTENSION_REGEX = /\.(txt|json|js|mjs|cjs|ts|tsx|jsx|css|scss|sass|less|html|htm|md|xml|cfg|ini|lua|py|cpp|c|h|hpp|cs|java|go|rs|php|rb|sh|bat|ps1|sql|yaml|yml|toml|env|gitignore|properties|log|swift|kt|kts|dart|r|m|mm|vue|svelte|astro|graphql|gql|prisma|diff|patch|dockerfile|makefile)$/i;

let db;

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

// Check if raw file data contains standard printable text (Fallback for unknown file types)
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

// ---------------------------
// Initialize App
// ---------------------------
document.addEventListener("DOMContentLoaded", function () {
    initDatabase();
    bindUIEvents();
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
    document.getElementById("tokenInput").value = localStorage.getItem("gh_token") || "";
    document.getElementById("repoInput").value = localStorage.getItem("gh_repo") || "";
    document.getElementById("branchInput").value = localStorage.getItem("gh_branch") || "main";
}

document.getElementById("tokenInput").addEventListener("input", e => localStorage.setItem("gh_token", e.target.value.trim()));
document.getElementById("repoInput").addEventListener("input", e => localStorage.setItem("gh_repo", e.target.value.trim()));
document.getElementById("branchInput").addEventListener("input", e => localStorage.setItem("gh_branch", e.target.value.trim()));

// ---------------------------
// UI Control Event Bindings
// ---------------------------
function bindUIEvents() {
    const editor = document.getElementById("editor");
    const lineNumbers = document.getElementById("lineNumbers");

    editor.addEventListener("input", updateLineNumbers);
    editor.addEventListener("scroll", function () {
        lineNumbers.scrollTop = editor.scrollTop;
    });

    bindClick("closeFileBtn", function () {
        editor.value = "";
        editor.dataset.filename = "";
        document.getElementById("activeFileLabel").textContent = "No file selected";
        updateLineNumbers();
    });

    bindClick("searchToggleBtn", function () {
        const bar = document.getElementById("searchReplaceBar");
        bar.classList.toggle("hidden");
    });

    bindClick("fullscreenBtn", function () {
        const appContainer = document.getElementById("appContainer");
        const isFullscreen = appContainer.classList.toggle("fullscreen");
        document.getElementById("fullscreenBtn").textContent = isFullscreen ? "⛶ Exit" : "⛶ Fullscreen";
    });

    bindClick("replaceBtn", function () {
        const searchVal = document.getElementById("searchInput").value;
        const replaceVal = document.getElementById("replaceInput").value;
        if (!searchVal) return;

        editor.value = editor.value.replace(searchVal, replaceVal);
        updateLineNumbers();
    });

    bindClick("replaceAllBtn", function () {
        const searchVal = document.getElementById("searchInput").value;
        const replaceVal = document.getElementById("replaceInput").value;
        if (!searchVal) return;

        const regex = new RegExp(escapeRegExp(searchVal), "g");
        editor.value = editor.value.replace(regex, replaceVal);
        updateLineNumbers();
    });

    bindClick("saveLocalBtn", function () {
        const name = editor.dataset.filename;
        if (!name) return alert("Select a file first.");

        const content = editor.value;
        const tx = db.transaction("files", "readwrite");
        const store = tx.objectStore("files");
        store.put({ name, content });

        tx.oncomplete = () => alert("Saved!");
    });

    bindClick("newFileBtn", function () {
        const name = prompt("Enter file path (e.g., src/components/App.tsx):");
        if (!name) return;

        const tx = db.transaction("files", "readwrite");
        const store = tx.objectStore("files");
        store.put({ name, content: "" });

        tx.oncomplete = () => {
            loadFiles();
            openFile(name);
        };
    });

    bindClick("pushGitHubBtn", async function () {
        const token = document.getElementById("tokenInput").value.trim();
        const repo = document.getElementById("repoInput").value.trim();
        const branch = document.getElementById("branchInput").value.trim();
        const name = editor.dataset.filename;
        const content = editor.value;

        if (!token || !repo || !name) return alert("Select a file & fill GitHub credentials.");

        try {
            await pushFileToGitHub(name, content, token, repo, branch);
            alert(`Pushed ${name}!`);
        } catch (err) {
            alert("Push failed: " + err.message);
        }
    });

    bindClick("pushAllGitHubBtn", async function () {
        const token = document.getElementById("tokenInput").value.trim();
        const repo = document.getElementById("repoInput").value.trim();
        const branch = document.getElementById("branchInput").value.trim();

        if (!token || !repo) return alert("Fill GitHub credentials.");

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

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

// ---------------------------
// Universal File & Directory Rendering
// ---------------------------
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
        renderTree(treeRoot, container);
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

function renderTree(node, container) {
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
            const childrenContainer = document.createElement("div");
            childrenContainer.className = "tree-children";
            childrenContainer.style.display = "none";

            treeNode.innerHTML = `
                <div class="tree-row" onclick="toggleFolder(this)">
                    <span class="tree-label">📁 <strong>${key}</strong></span>
                </div>
            `;
            renderTree(item._children, childrenContainer);
            treeNode.appendChild(childrenContainer);
        }
        container.appendChild(treeNode);
    }
}

function toggleFolder(rowElement) {
    const children = rowElement.nextElementSibling;
    if (children) {
        const isHidden = children.style.display === "none";
        children.style.display = isHidden ? "block" : "none";
        const folderIcon = rowElement.querySelector(".tree-label");
        if (folderIcon) {
            folderIcon.innerHTML = folderIcon.innerHTML.replace(isHidden ? "📁" : "📂", isHidden ? "📂" : "📁");
        }
    }
}

// ---------------------------
// Multi-Format File Import Logic
// ---------------------------
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
                // If unknown extension contains non-printable data, convert to base64 Data URL
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

            const isText = entry.name.match(EXTENSION_REGEX);
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

// ---------------------------
// File Workspace Operations
// ---------------------------
function openFile(name) {
    const tx = db.transaction("files", "readonly");
    const store = tx.objectStore("files");
    const req = store.get(name);

    req.onsuccess = function () {
        const editor = document.getElementById("editor");
        editor.value = req.result.content;
        editor.dataset.filename = name;
        document.getElementById("activeFileLabel").textContent = "Editing: " + name;
        updateLineNumbers();
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
        }
        loadFiles();
    };
}

// ---------------------------
// GitHub Push Integration
// ---------------------------
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
