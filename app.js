// ---------------------------
// IndexedDB Setup
// ---------------------------
let db;
const request = indexedDB.open("LocalWorkspaceDB", 2);

request.onupgradeneeded = function (event) {
    db = event.target.result;
    if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "name" });
    }
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

// ---------------------------
// Handle regular file
// ---------------------------
async function importRegularFile(file) {
    const reader = new FileReader();

    return new Promise(resolve => {
        reader.onload = function () {
            const tx = db.transaction("files", "readwrite");
            const store = tx.objectStore("files");

            store.put({
                name: file.name,
                content: reader.result
            });

            tx.oncomplete = resolve;
        };

        reader.readAsText(file);
    });
}

// ---------------------------
// Handle ZIP file
// ---------------------------
async function unpackZip(zipFile) {
    const arrayBuffer = await zipFile.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");

    for (const filename of Object.keys(zip.files)) {
        const entry = zip.files[filename];

        if (entry.dir) continue; // skip folders

        // Skip binary files
        const isBinary = /\.(png|jpg|jpeg|gif|bmp|exe|dll|bin)$/i.test(filename);
        if (isBinary) continue;

        const content = await entry.async("string");

        store.put({
            name: filename,
            content: content
        });
    }

    return new Promise(resolve => tx.oncomplete = resolve);
}

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
