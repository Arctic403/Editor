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
// LocalStorage Persistence
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
// Load Files
// ---------------------------
function loadFiles() {
    const tx = db.transaction("files", "readonly");
    const store = tx.objectStore("files");
    const req = store.getAll();

    req.onsuccess = function () {
        const list = document.getElementById("fileList");
        list.innerHTML = "";

        req.result.forEach(file => {
            const li = document.createElement("li");
            li.innerHTML = `
                <span>${file.name}</span>
                <div>
                    <button onclick="openFile('${file.name}')">Open</button>
                    <button onclick="deleteFile('${file.name}')">Delete</button>
                </div>
            `;
            list.appendChild(li);
        });
    };
}

// ---------------------------
// Create New File
// ---------------------------
document.getElementById("newFileBtn").onclick = function () {
    const name = prompt("File name (e.g., index.html or src/main.js):");
    if (!name) return;

    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.put({ name, content: "" });

    tx.oncomplete = () => {
        loadFiles();
        openFile(name);
    };
};

// ---------------------------
// Upload File or ZIP
// ---------------------------
document.getElementById("uploadInput").onchange = async function (event) {
    const files = event.target.files;

    for (const file of files) {
        if (file.name.toLowerCase().endsWith(".zip")) {
            await unpackZip(file);
        } else {
            await importRegularFile(file);
        }
    }

    loadFiles();
};

async function importRegularFile(file) {
    const reader = new FileReader();
    return new Promise(resolve => {
        reader.onload = function () {
            const tx = db.transaction("files", "readwrite");
            const store = tx.objectStore("files");
            store.put({ name: file.name, content: reader.result });
            tx.oncomplete = resolve;
        };
        reader.readAsText(file);
    });
}

async function unpackZip(zipFile) {
    try {
        const arrayBuffer = await zipFile.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);

        const tx = db.transaction("files", "readwrite");
        const store = tx.objectStore("files");

        for (const path in zip.files) {
            const entry = zip.files[path];
            if (entry.dir) continue;

            const isText = entry.name.match(/\.(txt|json|js|css|html|md|xml|cfg|ini|lua)$/i);
            let content;

            if (isText) {
                content = await entry.async("string");
            } else {
                const base64 = await entry.async("base64");
                content = "data:application/octet-stream;base64," + base64;
            }

            store.put({ name: entry.name, content });
        }

        return new Promise(resolve => tx.oncomplete = resolve);
    } catch (err) {
        console.error("ZIP unpack error:", err);
        alert("Failed to unpack ZIP.");
    }
}

// ---------------------------
// Open & Delete File
// ---------------------------
function openFile(name) {
    const tx = db.transaction("files", "readonly");
    const store = tx.objectStore("files");
    const req = store.get(name);

    req.onsuccess = function () {
        document.getElementById("editor").value = req.result.content;
        document.getElementById("editor").dataset.filename = name;
        document.getElementById("activeFileLabel").textContent = "Editing: " + name;
    };
}

function deleteFile(name) {
    if (!confirm(`Delete ${name}?`)) return;
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.delete(name);
    tx.oncomplete = () => {
        if (document.getElementById("editor").dataset.filename === name) {
            document.getElementById("editor").value = "";
            document.getElementById("editor").dataset.filename = "";
            document.getElementById("activeFileLabel").textContent = "No file selected";
        }
        loadFiles();
    };
}

// ---------------------------
// Save Locally
// ---------------------------
document.getElementById("saveLocalBtn").onclick = function () {
    const name = document.getElementById("editor").dataset.filename;
    if (!name) return alert("No file selected.");

    const content = document.getElementById("editor").value;
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.put({ name, content });

    tx.oncomplete = () => alert("Saved locally!");
};

// ---------------------------
// GitHub Integration (Single & Batch)
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
    } catch (err) {
        console.warn("New file commit detected.");
    }

    const bytes = new TextEncoder().encode(content);
    const base64Content = btoa(String.fromCharCode(...bytes));

    const body = {
        message: `Update ${name} via Web Editor`,
        content: base64Content,
        branch: branch,
        ...(sha && { sha })
    };

    const res = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || res.status);
    }
}

document.getElementById("pushGitHubBtn").onclick = async function () {
    const token = document.getElementById("tokenInput").value.trim();
    const repo = document.getElementById("repoInput").value.trim();
    const branch = document.getElementById("branchInput").value.trim();
    const name = document.getElementById("editor").dataset.filename;
    const content = document.getElementById("editor").value;

    if (!token || !repo || !name) {
        return alert("Please select a file and ensure Token & Repo fields are filled out.");
    }

    try {
        await pushFileToGitHub(name, content, token, repo, branch);
        alert(`Pushed ${name} successfully!`);
    } catch (err) {
        alert("GitHub Push Error: " + err.message);
    }
};

document.getElementById("pushAllGitHubBtn").onclick = async function () {
    const token = document.getElementById("tokenInput").value.trim();
    const repo = document.getElementById("repoInput").value.trim();
    const branch = document.getElementById("branchInput").value.trim();

    if (!token || !repo) {
        return alert("Please ensure Token & Repo fields are filled out.");
    }

    const tx = db.transaction("files", "readonly");
    const store = tx.objectStore("files");
    const req = store.getAll();

    req.onsuccess = async function () {
        const files = req.result;
        if (files.length === 0) return alert("No local files to push.");

        let successCount = 0;
        for (const file of files) {
            try {
                await pushFileToGitHub(file.name, file.content, token, repo, branch);
                successCount++;
            } catch (err) {
                console.error(`Failed to push ${file.name}:`, err);
            }
        }
        alert(`Pushed ${successCount} of ${files.length} files to GitHub!`);
    };
};
