// ---------------------------
// IndexedDB Setup
// ---------------------------
let db;
const request = indexedDB.open("LocalWorkspaceDB", 1);

request.onupgradeneeded = function (event) {
    db = event.target.result;
    db.createObjectStore("files", { keyPath: "name" });
};

request.onsuccess = function (event) {
    db = event.target.result;
    loadFiles();
};

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
    const name = prompt("File name:");
    if (!name) return;

    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.put({ name, content: "" });

    tx.oncomplete = loadFiles;
};

// ---------------------------
// Upload File
// ---------------------------
document.getElementById("uploadInput").onchange = function (event) {
    const file = event.target.files[0];
    const reader = new FileReader();

    reader.onload = function () {
        const tx = db.transaction("files", "readwrite");
        const store = tx.objectStore("files");
        store.put({ name: file.name, content: reader.result });
        tx.oncomplete = loadFiles;
    };

    reader.readAsText(file);
};

// ---------------------------
// Open File
// ---------------------------
function openFile(name) {
    const tx = db.transaction("files", "readonly");
    const store = tx.objectStore("files");
    const req = store.get(name);

    req.onsuccess = function () {
        document.getElementById("editor").value = req.result.content;
        document.getElementById("editor").dataset.filename = name;
    };
}

// ---------------------------
// Delete File
// ---------------------------
function deleteFile(name) {
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.delete(name);
    tx.oncomplete = loadFiles;
}

// ---------------------------
// Save Locally
// ---------------------------
document.getElementById("saveLocalBtn").onclick = function () {
    const name = document.getElementById("editor").dataset.filename;
    const content = document.getElementById("editor").value;

    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.put({ name, content });

    tx.oncomplete = loadFiles;
};

// ---------------------------
// Push to GitHub
// ---------------------------
document.getElementById("pushGitHubBtn").onclick = async function () {
    const token = document.getElementById("tokenInput").value;
    const repo = document.getElementById("repoInput").value;
    const branch = document.getElementById("branchInput").value;

    const name = document.getElementById("editor").dataset.filename;
    const content = document.getElementById("editor").value;

    const encoded = btoa(unescape(encodeURIComponent(content)));

    const url = `https://api.github.com/repos/${repo}/contents/${name}`;

    const body = {
        message: `Update ${name}`,
        content: encoded,
        branch: branch
    };

    const res = await fetch(url, {
        method: "PUT",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (res.ok) {
        alert("Committed to GitHub!");
    } else {
        alert("Error: " + res.status);
    }
};
