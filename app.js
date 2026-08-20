// Universal Text Extension Regex
const TEXT_EXTENSIONS_REGEX = /\.(txt|json|js|mjs|cjs|ts|tsx|jsx|css|scss|sass|less|html|htm|md|xml|cfg|ini|lua|py|cpp|c|h|hpp|cs|java|go|rs|php|rb|sh|bat|ps1|sql|yaml|yml|toml|env|gitignore|properties|log)$/i;

// ---------------------------
// IndexedDB Setup
// ---------------------------
let db;
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

// ---------------------------
// LocalStorage Settings
// ---------------------------
function restoreSettings() {
    document.getElementById("tokenInput").value = localStorage.getItem("gh_token") || "";
    document.getElementById("repoInput").value = localStorage.getItem("gh_repo") || "";
    document.getElementById("branchInput").value = localStorage.getItem("gh_branch") || "main";
}

document.getElementById("tokenInput").addEventListener("input", e => localStorage.setItem("gh_token", e.target.value.trim()));
document.getElementById("repoInput").addEventListener("input", e => localStorage.setItem("gh_repo", e.target.value.trim()));
document.getElementById("branchInput").addEventListener("input", e => localStorage.setItem("gh_branch", e.target.value.trim()));

// ---------------------------
// File Tree Manager Logic
// ---------------------------
function loadFiles() {
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
            if (["html", "htm"].includes(ext)) icon = "🌐";
            else if (["css", "scss"].includes(ext)) icon = "🎨";
            else if (["js", "ts", "jsx", "tsx", "json"].includes(ext)) icon = "⚡";
            else if (["py", "cpp", "c", "h", "cs", "java", "rs", "go"].includes(ext)) icon = "⚙️";

            treeNode.innerHTML = `
                <div class="tree-row" onclick="openFile('${item.fullPath}')">
                    <span class="tree-label">${icon} ${key}</span>
                    <span class="delete-icon" onclick="event.stopPropagation(); deleteFile('${item.fullPath}')">✕</span>
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
// File Import Operations (Chrome & Safari Fixed)
// ---------------------------
document.getElementById("newFileBtn").onclick = function () {
    const name = prompt("Enter file path (e.g., src/index.js):");
    if (!name) return;

    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.put({ name, content: "" });

    tx.oncomplete = () => {
        loadFiles();
        openFile(name);
    };
};

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
            const tx = db.transaction("files", "readwrite");
            const store = tx.objectStore("files");
            store.put({ name: file.name, content: reader.result });
            tx.oncomplete = resolve;
        };
        reader.onerror = reject;

        if (file.name.match(TEXT_EXTENSIONS_REGEX)) {
            reader.readAsText(file);
        } else {
            reader.readAsDataURL(file);
        }
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

            const isText = entry.name.match(TEXT_EXTENSIONS_REGEX);
            let content;

            if (isText) {
                content = await entry.async("string");
            } else {
                const base64 = await entry.async("base64");
                content = "data:application/octet-stream;base64," + base64;
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
// File Editor & Controls
// ---------------------------
const editor = document.getElementById("editor");
const lineNumbers = document.getElementById("lineNumbers");

function updateLineNumbers() {
    const lines = editor.value.split("\n").length;
    let numbersArr = [];
    for (let i = 1; i <= lines; i++) {
        numbersArr.push(i);
    }
    lineNumbers.textContent = numbersArr.join("\n");
}

editor.addEventListener("input", updateLineNumbers);
editor.addEventListener("scroll", () => {
    lineNumbers.scrollTop = editor.scrollTop;
});

function openFile(name) {
    const tx = db.transaction("files", "readonly");
    const store = tx.objectStore("files");
    const req = store.get(name);

    req.onsuccess = function () {
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
        if (editor.dataset.filename === name) {
            closeActiveFile();
        }
        loadFiles();
    };
}

function closeActiveFile() {
    editor.value = "";
    editor.dataset.filename = "";
    document.getElementById("activeFileLabel").textContent = "No file selected";
    updateLineNumbers();
}

document.getElementById("closeFileBtn").onclick = closeActiveFile;

document.getElementById("saveLocalBtn").onclick = function () {
    const name = editor.dataset.filename;
    if (!name) return alert("Select a file first.");

    const content = editor.value;
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.put({ name, content });

    tx.oncomplete = () => alert("Saved!");
};

// Fullscreen Toggle
document.getElementById("fullscreenBtn").onclick = function () {
    const appContainer = document.getElementById("appContainer");
    appContainer.classList.toggle("fullscreen");
    this.textContent = appContainer.classList.contains("fullscreen") ? "⛶ Exit" : "⛶ Fullscreen";
};

// Search & Replace Toggle
document.getElementById("searchToggleBtn").onclick = function () {
    document.getElementById("searchReplaceBar").classList.toggle("hidden");
};

document.getElementById("replaceBtn").onclick = function () {
    const searchVal = document.getElementById("searchInput").value;
    const replaceVal = document.getElementById("replaceInput").value;
    if (!searchVal) return;
    editor.value = editor.value.replace(searchVal, replaceVal);
    updateLineNumbers();
};

document.getElementById("replaceAllBtn").onclick = function () {
    const searchVal = document.getElementById("searchInput").value;
    const replaceVal = document.getElementById("replaceInput").value;
    if (!searchVal) return;
    editor.value = editor.value.replaceAll(searchVal, replaceVal);
    updateLineNumbers();
};

// ---------------------------
// GitHub Push Operations
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

document.getElementById("pushGitHubBtn").onclick = async function () {
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
};

document.getElementById("pushAllGitHubBtn").onclick = async function () {
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
};
