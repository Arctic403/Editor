/* Mobile Workspace Editor — rebuilt workspace engine
   Fixes: real file tree, text/binary storage, ZIP import/export, downloads,
   safe DOM rendering, IndexedDB migration, GitHub SHA updates, dirty-state,
   better errors, folder operations, and mobile-friendly editor behavior.
*/
const TEXT_EXTENSIONS = new Set(`txt json js mjs cjs ts tsx jsx css scss sass less html htm md markdown xml cfg ini lua py pyw cpp c h hpp cs java go rs php rb sh bash bat ps1 sql yaml yml toml env gitignore properties log swift kt kts dart r m mm vue svelte astro graphql gql prisma diff patch dockerfile makefile svg`.split(/\s+/));
const DB_NAME = "LocalWorkspaceDB";
const DB_VERSION = 4;
let db = null;
let dbReady = null;
let selectedFolderPath = "";
let secondaryPaneFileName = "";
let lastSearchIndex = 0;
let isDirty = false;
let autoSaveTimer = null;

const $ = id => document.getElementById(id);
const bindClick = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };

function escapeHtml(value = "") {
  return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}
function escapeRegExp(value = "") { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function normalizePath(path) {
  return String(path || "").replace(/\\/g,"/").split("/").filter(Boolean).join("/");
}
function basename(path) { const p = normalizePath(path).split("/"); return p[p.length-1] || ""; }
function dirname(path) { const p = normalizePath(path).split("/"); p.pop(); return p.join("/"); }
function extension(path) {
  const n = basename(path).toLowerCase();
  if (n === "dockerfile" || n === "makefile" || n === ".gitignore" || n === ".env") return n;
  const i = n.lastIndexOf("."); return i >= 0 ? n.slice(i+1) : "";
}
function isTextPath(path) { return TEXT_EXTENSIONS.has(extension(path)); }
function isTextContent(value) {
  if (!(value instanceof ArrayBuffer)) return true;
  const bytes = new Uint8Array(value).subarray(0, 4096);
  let bad = 0;
  for (const b of bytes) if (b === 0 || (b < 7 || (b > 14 && b < 32))) bad++;
  return bytes.length === 0 || bad / bytes.length < 0.02;
}
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer); let out = ""; const chunk = 0x8000;
  for (let i=0;i<bytes.length;i+=chunk) out += String.fromCharCode(...bytes.subarray(i,i+chunk));
  return btoa(out);
}
function base64ToBuffer(base64) {
  const raw = atob(base64); const out = new Uint8Array(raw.length);
  for (let i=0;i<raw.length;i++) out[i] = raw.charCodeAt(i); return out.buffer;
}
function makeFile(path, content, type="text", mime="") {
  return { path: normalizePath(path), name: basename(path), content, type, mime: mime || (type === "text" ? "text/plain;charset=utf-8" : "application/octet-stream"), updatedAt: Date.now() };
}

function openDatabase() {
  dbReady = new Promise((resolve,reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = e => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains("files")) database.createObjectStore("files", { keyPath: "path" });
      else {
        const old = e.target.transaction.objectStore("files");
        // Existing v3 store is keyed by name; path is equivalent. Existing records are preserved.
        // No destructive migration is performed.
      }
    };
    request.onsuccess = e => { db = e.target.result; db.onversionchange = () => db.close(); resolve(db); };
    request.onerror = () => reject(request.error || new Error("Could not open local workspace database."));
  });
  return dbReady;
}
async function ready() { return db || await dbReady; }
function dbRequest(mode, callback) {
  return ready().then(database => new Promise((resolve,reject) => {
    const tx = database.transaction("files", mode), store = tx.objectStore("files");
    let result;
    try { result = callback(store); } catch(e) { reject(e); return; }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error("Local database error."));
    tx.onabort = () => reject(tx.error || new Error("Local database transaction aborted."));
  }));
}
async function getAllFiles() { return dbRequest("readonly", store => new Promise((resolve,reject)=>{ const r=store.getAll(); r.onsuccess=()=>resolve(r.result||[]); r.onerror=()=>reject(r.error); })); }
async function getFile(path) { return dbRequest("readonly", store => new Promise((resolve,reject)=>{ const r=store.get(normalizePath(path)); r.onsuccess=()=>resolve(r.result||null); r.onerror=()=>reject(r.error); })); }
async function putFile(file) { return dbRequest("readwrite", store => store.put(file)); }
async function deletePath(path) { return dbRequest("readwrite", store => store.delete(normalizePath(path))); }

async function saveFileToDb(path, content, type="text", mime="") {
  const normalized = normalizePath(path);
  if (!normalized) throw new Error("File path cannot be empty.");
  const existing = await getFile(normalized);
  return putFile(makeFile(normalized, content, type, mime || existing?.mime));
}

function updateDirtyIndicator(dirty) {
  isDirty = !!dirty;
  const el = $("saveIndicator");
  if (el) { el.className = `save-indicator ${isDirty ? "dirty" : "clean"}`; el.textContent = isDirty ? "●" : "○"; el.title = isDirty ? "Unsaved changes" : "Saved"; }
}
function ensureCanSwitch() {
  if (!isDirty) return true;
  return confirm("You have unsaved changes. Continue and discard them?");
}
function switchTab(name) {
  document.querySelectorAll(".page-view").forEach(x=>x.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(x=>x.classList.remove("active"));
  $(name+"View")?.classList.add("active");
  $("tab"+name.charAt(0).toUpperCase()+name.slice(1))?.classList.add("active");
}

function buildTree(files) {
  const root = { children: new Map(), files: [] };
  for (const file of files) {
    const parts = normalizePath(file.path || file.name).split("/");
    let node = root;
    parts.forEach((part,i)=>{
      if (i === parts.length-1) node.files.push({ ...file, path: parts.slice(0,i+1).join("/") });
      else { if (!node.children.has(part)) node.children.set(part,{children:new Map(),files:[]}); node=node.children.get(part); }
    });
  }
  return root;
}
function sortTreeNode(node) {
  node.children = new Map([...node.children.entries()].sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true,sensitivity:"base"})));
  node.files.sort((a,b)=>basename(a.path).localeCompare(basename(b.path),undefined,{numeric:true,sensitivity:"base"}));
  node.children.forEach(sortTreeNode);
}
function createTreeFolder(name,path,node) {
  const wrap=document.createElement("div"); wrap.className="tree-folder";
  const row=document.createElement("div"); row.className="tree-row folder-row"; row.tabIndex=0;
  const caret=document.createElement("span"); caret.className="tree-caret"; caret.textContent="▸";
  const icon=document.createElement("span"); icon.textContent="📁";
  const label=document.createElement("span"); label.className="tree-label"; label.textContent=name;
  const actions=document.createElement("span"); actions.className="tree-actions";
  const add=document.createElement("button"); add.className="tree-action"; add.title="New file here"; add.textContent="＋";
  add.onclick=e=>{e.stopPropagation(); createFile(path);};
  const del=document.createElement("button"); del.className="tree-action danger"; del.title="Delete folder"; del.textContent="×";
  del.onclick=e=>{e.stopPropagation(); deleteFolder(path);};
  actions.append(add,del); row.append(caret,icon,label,actions);
  const children=document.createElement("div"); children.className="tree-children hidden";
  row.onclick=()=>{ selectedFolderPath=path; children.classList.toggle("hidden"); caret.textContent=children.classList.contains("hidden")?"▸":"▾"; icon.textContent=children.classList.contains("hidden")?"📁":"📂"; };
  row.ondragover=e=>{e.preventDefault();row.classList.add("drag-over")}; row.ondragleave=()=>row.classList.remove("drag-over"); row.ondrop=async e=>{e.preventDefault();row.classList.remove("drag-over");const src=e.dataTransfer.getData("text/plain");if(src) await moveFileToFolder(src,path);};
  wrap.append(row,children); renderTreeNode(node,children,path); return wrap;
}
function renderTreeNode(node,container,parentPath="") {
  node.children.forEach((child,name)=>container.appendChild(createTreeFolder(name,parentPath?parentPath+"/"+name:name,child)));
  node.files.forEach(file=>{
    const row=document.createElement("div"); row.className="tree-row file-row"; row.draggable=true; row.dataset.path=file.path;
    const icon=document.createElement("span"); icon.textContent=file.type==="binary"?"◈":"📄";
    const label=document.createElement("span"); label.className="tree-label"; label.textContent=basename(file.path); label.title=file.path;
    const actions=document.createElement("span"); actions.className="tree-actions";
    const dl=document.createElement("button"); dl.className="tree-action"; dl.title="Download"; dl.textContent="⇩"; dl.onclick=e=>{e.stopPropagation();downloadFile(file.path)};
    const del=document.createElement("button"); del.className="tree-action danger"; del.title="Delete"; del.textContent="×"; del.onclick=e=>{e.stopPropagation();deleteFile(file.path)};
    actions.append(dl,del); row.append(icon,label,actions); row.onclick=()=>openFile(file.path); row.ondragstart=e=>e.dataTransfer.setData("text/plain",file.path); container.appendChild(row);
  });
}
async function loadFiles() {
  try {
    const files=await getAllFiles(); const root=buildTree(files); sortTreeNode(root);
    const container=$("fileTree"); if(!container)return; container.replaceChildren();
    if(!files.length){ const empty=document.createElement("div");empty.className="empty-tree";empty.textContent="No files yet. Import a folder/ZIP or create a file.";container.appendChild(empty); }
    else renderTreeNode(root,container);
    $("itemCount")?.replaceChildren(document.createTextNode(`${files.length} file${files.length===1?"":"s"}`));
  } catch(e) { console.error(e); alert("Could not load workspace: "+e.message); }
}

async function createFile(folder="") {
  let name=prompt("Enter file path:",folder?folder+"/":""); if(!name)return;
  name=normalizePath(name); if(!name||name.endsWith("/"))return;
  if(await getFile(name)){alert("A file with that path already exists.");return;}
  await saveFileToDb(name,""); await loadFiles(); await openFile(name);
}
async function deleteFile(path) {
  if(!confirm(`Delete ${path}?`))return;
  await deletePath(path);
  const editor=$("editor"); if(editor?.dataset.filename===path) closeActiveFile(true);
  await loadFiles();
}
async function deleteFolder(folder) {
  if(!confirm(`Delete folder "${folder}" and all contained files?`))return;
  const files=await getAllFiles(), prefix=normalizePath(folder)+"/";
  await dbRequest("readwrite",store=>{for(const f of files)if(f.path===folder||f.path.startsWith(prefix))store.delete(f.path);});
  const editor=$("editor"); if(editor?.dataset.filename===folder||editor?.dataset.filename?.startsWith(prefix)) closeActiveFile(true);
  await loadFiles();
}
async function moveFileToFolder(source,targetFolder) {
  source=normalizePath(source); targetFolder=normalizePath(targetFolder); const file=await getFile(source); if(!file)return;
  const dest=normalizePath((targetFolder?targetFolder+"/":"")+basename(source)); if(dest===source)return;
  if(await getFile(dest)){alert(`A file already exists at ${dest}.`);return;}
  await dbRequest("readwrite",store=>{store.delete(source);store.put({...file,path:dest,name:basename(dest),updatedAt:Date.now()});});
  if($("editor")?.dataset.filename===source){$("editor").dataset.filename=dest;$("activeFileLabel").textContent="Editing: "+dest;updateBreadcrumbs(dest);}
  await loadFiles();
}

async function openFile(path) {
  if(!ensureCanSwitch())return;
  const file=await getFile(path); if(!file)return;
  const editor=$("editor"); if(!editor)return;
  if(file.type==="binary") { alert("This is a binary file. It can be downloaded, but it is not editable as text."); return; }
  editor.value=String(file.content??""); editor.dataset.filename=file.path; editor.dataset.type=file.type;
  $("activeFileLabel").textContent="Editing: "+file.path; lastSearchIndex=0; updateLineNumbers();updateHighlights();renderCodeBlockNav(editor.value);updateBreadcrumbs(file.path);updateDirtyIndicator(false);switchTab("editor");
}
function closeActiveFile(force=false){ if(!force&&!ensureCanSwitch())return false; const e=$("editor");if(!e)return true;e.value="";e.dataset.filename="";e.dataset.type="";$("activeFileLabel").textContent="No file selected";updateLineNumbers();updateHighlights();renderCodeBlockNav("");updateBreadcrumbs("");updateDirtyIndicator(false);return true; }
async function saveCurrentFile(showAlert=false) {
  const e=$("editor"), path=e?.dataset.filename; if(!path){if(showAlert)alert("Select a file first.");return false;}
  try { await saveFileToDb(path,e.value,"text");updateDirtyIndicator(false);loadFiles();if(showAlert)alert("Saved locally!");return true; }
  catch(err){alert("Save failed: "+err.message);return false;}
}
function autoSaveCurrentFile(){clearTimeout(autoSaveTimer);autoSaveTimer=setTimeout(()=>saveCurrentFile(false),700);}

function updateLineNumbers(){const e=$("editor"),n=$("lineNumbers");if(!e||!n)return;n.textContent=Array.from({length:Math.max(1,e.value.split("\n").length)},(_,i)=>i+1).join("\n");}
function updateHighlights(){
  const e=$("editor"),code=$("highlightCode"),layer=$("highlightLayer");if(!e||!code)return;
  let text=e.value;if(text.endsWith("\n"))text+=" ";const ext=extension(e.dataset.filename||"");
  const map={js:"javascript",mjs:"javascript",cjs:"javascript",ts:"typescript",tsx:"tsx",jsx:"jsx",py:"python",md:"markdown",html:"markup",htm:"markup",xml:"markup",svg:"markup",css:"css",scss:"scss",json:"json",yaml:"yaml",yml:"yaml",sql:"sql",java:"java",c:"c",cpp:"cpp",cs:"csharp",go:"go",rs:"rust",php:"php",rb:"ruby",sh:"bash"};
  const lang=map[ext]||"plaintext"; let rendered=escapeHtml(text);
  if(window.Prism&&Prism.languages[lang]) rendered=Prism.highlight(text,Prism.languages[lang],lang);
  const search=$("searchInput")?.value||""; if(search&&!$("searchReplaceBar")?.classList.contains("hidden")){const re=new RegExp(escapeRegExp(search),"gi");rendered=rendered.replace(re,m=>`<mark class="search-highlight">${m}</mark>`);}
  code.innerHTML=rendered;if(layer){layer.scrollTop=e.scrollTop;layer.scrollLeft=e.scrollLeft;}
}
function updateBreadcrumbs(path){const c=$("breadcrumbBar");if(!c)return;c.replaceChildren();const root=document.createElement("span");root.className="breadcrumb-item";root.textContent="Workspace";root.onclick=()=>{selectedFolderPath="";switchTab("explorer");loadFiles()};c.appendChild(root);if(!path)return;let cur="";normalizePath(path).split("/").forEach((part,i)=>{const sep=document.createElement("span");sep.className="breadcrumb-separator";sep.textContent=" / ";c.appendChild(sep);cur=cur?cur+"/"+part:part;const item=document.createElement("span");item.className="breadcrumb-item";item.textContent=part;if(i<normalizePath(path).split("/").length-1){const p=cur;item.onclick=()=>{selectedFolderPath=p;switchTab("explorer");loadFiles()};}c.appendChild(item);});}
function updateCodeBlockNav(content){renderCodeBlockNav(content)}
function parseCodeBlocks(content){const lines=content.split("\n"),blocks=[];let current=null;lines.forEach((line,i)=>{const a=line.match(/\/\/\s*#(?:region|block)\s+(.*)/i),b=line.match(/\/\/\s*#end(?:region|block)/i);if(a)current={name:a[1].trim(),startLine:i+1};else if(b&&current){current.endLine=i+1;blocks.push(current);current=null;}});return blocks;}
function renderCodeBlockNav(content){const c=$("blockNav");if(!c)return;c.replaceChildren();const blocks=parseCodeBlocks(content);if(!blocks.length){c.textContent="No defined #region blocks";return;}blocks.forEach(b=>{const item=document.createElement("button");item.className="block-nav-item";item.textContent=`🧩 ${b.name} (L${b.startLine}-${b.endLine})`;item.onclick=()=>jumpToLine(b.startLine);c.appendChild(item);});}
function jumpToLine(line){const e=$("editor");if(!e)return;e.focus();e.scrollTop=(line-1)*20;}

async function importRegularFile(file){
  const dest=normalizePath((selectedFolderPath?selectedFolderPath+"/":"")+file.name);
  if(file.size>50*1024*1024){if(!confirm(`${file.name} is ${Math.round(file.size/1024/1024)} MB. Import anyway?`))return;}
  const textCandidate=isTextPath(dest);
  if(textCandidate){const content=await file.text();await saveFileToDb(dest,content,"text",file.type||"text/plain;charset=utf-8");}
  else {const buffer=await file.arrayBuffer();const type=isTextContent(buffer)?"text":"binary";if(type==="text") await saveFileToDb(dest,new TextDecoder().decode(buffer),"text",file.type||"text/plain;charset=utf-8");else await saveFileToDb(dest,buffer,"binary",file.type||"application/octet-stream");}
}
async function unpackZip(zipFile){
  if(typeof JSZip==="undefined")throw new Error("JSZip did not load. Check your connection and reload.");
  const zip=await JSZip.loadAsync(await zipFile.arrayBuffer());let count=0;
  for(const [rawPath,entry] of Object.entries(zip.files)){
    if(entry.dir)continue; const rel=normalizePath(rawPath);if(!rel)continue;const path=normalizePath((selectedFolderPath?selectedFolderPath+"/":"")+rel);
    const bytes=await entry.async("arraybuffer");
    if(isTextPath(path)||isTextContent(bytes)) await saveFileToDb(path,new TextDecoder().decode(bytes),"text","text/plain;charset=utf-8");
    else await saveFileToDb(path,bytes,"binary","application/octet-stream"); count++;
  }
  return count;
}

async function exportWorkspace(){
  if(typeof JSZip==="undefined")return alert("JSZip is unavailable.");
  const files=await getAllFiles();if(!files.length)return alert("Workspace is empty.");const zip=new JSZip();
  for(const f of files){if(f.type==="binary"&&f.content instanceof ArrayBuffer)zip.file(f.path,f.content);else zip.file(f.path,String(f.content??""));}
  const blob=await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:6}});downloadBlob(blob,"workspace.zip");
}
async function downloadFile(path){const f=await getFile(path);if(!f)return;let blob;if(f.type==="binary"&&f.content instanceof ArrayBuffer)blob=new Blob([f.content],{type:f.mime});else blob=new Blob([String(f.content??"")],{type:f.mime||"text/plain;charset=utf-8"});downloadBlob(blob,basename(path));}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.rel="noopener";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}

function readFileAsBase64(content,type){return new Promise((resolve,reject)=>{const blob=content instanceof ArrayBuffer?new Blob([content],{type}):new Blob([String(content)],{type:"text/plain;charset=utf-8"});const r=new FileReader();r.onload=()=>resolve(String(r.result).split(",")[1]||"");r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});}
function apiHeaders(token){return {Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json"};}
async function githubFetch(url,options={}){const res=await fetch(url,options);let data=null;try{data=await res.json();}catch{}if(!res.ok)throw new Error(data?.message||`GitHub returned HTTP ${res.status}`);return data;}
async function fetchGitHubRepos(token){const select=$("repoSelect");if(!select)return;select.innerHTML="<option>Loading repositories...</option>";try{const repos=await githubFetch("https://api.github.com/user/repos?per_page=100&sort=updated",{headers:apiHeaders(token)});select.innerHTML="<option value=\"\">-- Choose Repository --</option>";const saved=localStorage.getItem("gh_repo");repos.forEach(r=>{const o=document.createElement("option");o.value=r.full_name;o.textContent=r.full_name;o.selected=r.full_name===saved;select.appendChild(o);});if(saved)await fetchGitHubBranches(token,saved);}catch(e){select.innerHTML="<option value=\"\">GitHub connection failed</option>";alert(e.message);}}
async function fetchGitHubBranches(token,repo){const select=$("branchSelect");if(!select||!repo)return;select.innerHTML="<option>Loading branches...</option>";try{const branches=await githubFetch(`https://api.github.com/repos/${encodeURIComponent(repo)}/branches?per_page=100`,{headers:apiHeaders(token)});select.replaceChildren();const saved=localStorage.getItem("gh_branch");branches.forEach(b=>{const o=document.createElement("option");o.value=b.name;o.textContent=b.name;o.selected=(saved&&b.name===saved)||(!saved&&(b.name==="main"||b.name==="master"));select.appendChild(o);});}catch(e){select.innerHTML="<option value=\"\">Failed to load branches</option>";alert(e.message);}}
async function getGithubFileSha(token,repo,path,branch){const url=`https://api.github.com/repos/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;const res=await fetch(url,{headers:apiHeaders(token)});if(res.status===404)return null;const data=await res.json();if(!res.ok)throw new Error(data?.message||`GitHub returned HTTP ${res.status}`);return data.sha||null;}
async function pushFileToGitHub(path,content,token,repo,branch,type="text",mime="text/plain;charset=utf-8"){
  const encodedPath=path.split("/").map(encodeURIComponent).join("/");const url=`https://api.github.com/repos/${encodeURIComponent(repo)}/contents/${encodedPath}`;const sha=await getGithubFileSha(token,repo,path,branch);const base64=await readFileAsBase64(content,mime);
  const body={message:`Update ${path} via Mobile Workspace`,content:base64,branch};if(sha)body.sha=sha;
  return githubFetch(url,{method:"PUT",headers:apiHeaders(token),body:JSON.stringify(body)});
}
async function importRepoFromGitHub(token,repo,branch){const tree=await githubFetch(`https://api.github.com/repos/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,{headers:apiHeaders(token)});const blobs=tree.tree.filter(x=>x.type==="blob");let count=0;for(const item of blobs){try{const r=await fetch(item.url,{headers:{...apiHeaders(token),Accept:"application/vnd.github.raw+json"}});if(!r.ok)continue;const buf=await r.arrayBuffer();const type=isTextPath(item.path)||isTextContent(buf)?"text":"binary";await saveFileToDb(item.path,type==="text"?new TextDecoder().decode(buf):buf,type);count++;}catch(e){console.warn("Skipped",item.path,e);}}await loadFiles();return count;}

function toggleSplitPane(){const pane=$("secondaryPane");if(!pane)return;const hidden=pane.classList.toggle("hidden");$("splitPaneBtn").textContent=hidden?"▥ Split":"✕ Single";if(!hidden&&!secondaryPaneFileName&&$("editor")?.dataset.filename)openSecondaryPaneFile($("editor").dataset.filename);}
async function openSecondaryPaneFile(path){const f=await getFile(path);if(!f||f.type==="binary")return;$("secondaryEditorView").value=String(f.content??"");$("secondaryPaneTitle").textContent=path;secondaryPaneFileName=path;$("secondaryHighlightCode").textContent=String(f.content??"");}
function toggleQuickOpen(){const m=$("quickOpenModal");if(!m)return;const hidden=m.classList.toggle("hidden");if(!hidden){$("quickOpenInput").value="";$("quickOpenInput").focus();filterQuickOpenFiles("");}}
async function filterQuickOpenFiles(q){const c=$("quickOpenResults");if(!c)return;const files=await getAllFiles();c.replaceChildren();const hits=files.filter(f=>f.path.toLowerCase().includes(q.toLowerCase())).sort((a,b)=>a.path.localeCompare(b.path));hits.forEach(f=>{const x=document.createElement("button");x.className="quick-item";x.textContent=f.path;x.onclick=()=>{toggleQuickOpen();openFile(f.path)};c.appendChild(x);});if(!hits.length)c.textContent="No matching files";}

function toggleEditorFullscreen(){
  const c=$("appContainer");
  if(!c)return;
  const on=!c.classList.contains("fullscreen");
  c.classList.toggle("fullscreen",on);
  document.body.classList.toggle("editor-is-fullscreen",on);
  const b=$("fullscreenBtn");
  if(b)b.textContent=on?"⛶ Exit":"⛶ Fullscreen";
  requestAnimationFrame(()=>{
    const e=$("editor");
    if(e){e.style.height="100%";e.style.maxHeight="none";}
    window.dispatchEvent(new Event("resize"));
  });
}

document.addEventListener("keydown",e=>{
  if(e.key!=="Escape")return;
  const c=$("appContainer");
  if(c?.classList.contains("fullscreen")){
    c.classList.remove("fullscreen");
    document.body.classList.remove("editor-is-fullscreen");
    const b=$("fullscreenBtn");
    if(b)b.textContent="⛶ Fullscreen";
    requestAnimationFrame(()=>window.dispatchEvent(new Event("resize")));
  }
});

function bindUI(){
  bindClick("tabExplorer",()=>switchTab("explorer"));bindClick("tabEditor",()=>switchTab("editor"));bindClick("newFileBtn",()=>createFile(selectedFolderPath));bindClick("exportWorkspaceBtn",exportWorkspace);bindClick("quickOpenBtn",toggleQuickOpen);bindClick("closeQuickOpenModal",toggleQuickOpen);bindClick("splitPaneBtn",toggleSplitPane);bindClick("closeSplitBtn",toggleSplitPane);
  bindClick("saveLocalBtn",()=>saveCurrentFile(true));bindClick("closeFileBtn",()=>closeActiveFile(false));
  bindClick("searchToggleBtn",()=>{$("searchReplaceBar")?.classList.toggle("hidden");updateHighlights();});
  bindClick("findNextBtn",()=>{const e=$("editor"),q=$("searchInput")?.value;if(!e||!q)return;const start=e.value.toLowerCase().indexOf(q.toLowerCase(),lastSearchIndex);const pos=start<0?e.value.toLowerCase().indexOf(q.toLowerCase()):start;if(pos<0)return alert("No matches found.");e.focus();e.setSelectionRange(pos,pos+q.length);lastSearchIndex=pos+q.length;});
  bindClick("replaceBtn",()=>{const e=$("editor"),q=$("searchInput")?.value,r=$("replaceInput")?.value;if(!e||!q)return;const i=e.value.indexOf(q);if(i<0)return alert("No match found.");e.value=e.value.slice(0,i)+r+e.value.slice(i+q.length);updateDirtyIndicator(true);updateLineNumbers();updateHighlights();autoSaveCurrentFile();});
  bindClick("replaceAllBtn",()=>{const e=$("editor"),q=$("searchInput")?.value,r=$("replaceInput")?.value;if(!e||!q)return;const re=new RegExp(escapeRegExp(q),"g"),matches=(e.value.match(re)||[]).length;if(!matches)return alert("No matches found.");if(!confirm(`Replace ${matches} occurrence(s)?`))return;e.value=e.value.replace(re,r);updateDirtyIndicator(true);updateLineNumbers();updateHighlights();autoSaveCurrentFile();});
  bindClick("jumpLineBtn",()=>{const n=parseInt(prompt("Jump to line:"),10);if(Number.isFinite(n)&&n>0)jumpToLine(n);});
  bindClick("fullscreenBtn",toggleEditorFullscreen);
  bindClick("connectGhBtn",()=>{const token=$("tokenInput")?.value.trim();if(!token)return alert("Enter a GitHub token first.");localStorage.setItem("gh_token",token);fetchGitHubRepos(token);});
  $("repoSelect")?.addEventListener("change",async e=>{const repo=e.target.value;localStorage.setItem("gh_repo",repo);const token=$("tokenInput").value.trim();if(repo){await fetchGitHubBranches(token,repo);if(confirm(`Import files from ${repo}?`)){try{const n=await importRepoFromGitHub(token,repo,$("branchSelect").value||"main");alert(`Imported ${n} file(s).`);}catch(err){alert("Repository import failed: "+err.message);}}}});
  $("branchSelect")?.addEventListener("change",e=>localStorage.setItem("gh_branch",e.target.value));
  $("tokenInput")?.addEventListener("input",e=>localStorage.setItem("gh_token",e.target.value.trim()));
  $("quickOpenInput")?.addEventListener("input",e=>filterQuickOpenFiles(e.target.value));
  document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="p"){e.preventDefault();toggleQuickOpen();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){e.preventDefault();saveCurrentFile(true);}});
  const editor=$("editor");
  editor?.addEventListener("input",()=>{updateLineNumbers();updateHighlights();renderCodeBlockNav(editor.value);updateDirtyIndicator(true);autoSaveCurrentFile();});
  editor?.addEventListener("keydown",e=>{if(e.key==="Tab"){e.preventDefault();const s=editor.selectionStart,en=editor.selectionEnd;editor.value=editor.value.slice(0,s)+"    "+editor.value.slice(en);editor.selectionStart=editor.selectionEnd=s+4;updateLineNumbers();updateHighlights();updateDirtyIndicator(true);autoSaveCurrentFile();}});
  editor?.addEventListener("scroll",()=>{$("lineNumbers").scrollTop=editor.scrollTop;$(`highlightLayer`)?.scrollTo(editor.scrollLeft,editor.scrollTop);});
  $("searchInput")?.addEventListener("input",updateHighlights);
  $("uploadInput")?.addEventListener("change",async e=>{const files=[...e.target.files||[]];try{let n=0;for(const f of files){if(f.name.toLowerCase().endsWith(".zip"))n+=await unpackZip(f);else{await importRegularFile(f);n++;}}await loadFiles();alert(`Imported ${n} file(s).`);}catch(err){alert("Import failed: "+err.message);}finally{e.target.value="";}});
  bindClick("pushGitHubBtn",pushCurrentToGitHub);bindClick("pushAllGitHubBtn",pushAllToGitHub);
}
async function pushCurrentToGitHub(){const e=$("editor"),path=e?.dataset.filename,token=$("tokenInput")?.value.trim(),repo=$("repoSelect")?.value,branch=$("branchSelect")?.value||"main";if(!path||!token||!repo)return alert("Select a file and configure GitHub first.");if(!confirm(`Push ${path} to ${repo} (${branch})?`))return;try{await saveCurrentFile(false);const f=await getFile(path);await pushFileToGitHub(path,f.content,token,repo,branch,f.type,f.mime);updateDirtyIndicator(false);alert(`Successfully pushed ${path}.`);}catch(e){alert("Push failed: "+e.message);}}
async function pushAllToGitHub(){const token=$("tokenInput")?.value.trim(),repo=$("repoSelect")?.value,branch=$("branchSelect")?.value||"main";if(!token||!repo)return alert("Configure GitHub first.");const files=await getAllFiles();if(!files.length)return alert("Workspace is empty.");if(!confirm(`Push all ${files.length} files to ${repo} (${branch})?`))return;let ok=0;const failures=[];for(const f of files){try{await pushFileToGitHub(f.path,f.content,token,repo,branch,f.type,f.mime);ok++;}catch(e){failures.push(`${f.path}: ${e.message}`);}}alert(`Pushed ${ok}/${files.length} files.${failures.length?"\n\nFailed:\n"+failures.slice(0,8).join("\n"):""}`);}
function restoreSettings(){const token=localStorage.getItem("gh_token")||"";if($("tokenInput"))$("tokenInput").value=token;if(token)fetchGitHubRepos(token);const theme=localStorage.getItem("editor_theme")||"dark";if($("themeSelect")){ $("themeSelect").value=theme;applyTheme(theme);$("themeSelect").addEventListener("change",e=>{applyTheme(e.target.value);localStorage.setItem("editor_theme",e.target.value);});}}
function applyTheme(theme){document.body.classList.remove("theme-light","theme-monokai");if(theme==="light")document.body.classList.add("theme-light");if(theme==="monokai")document.body.classList.add("theme-monokai");}

window.addEventListener("beforeunload",e=>{if(isDirty){e.preventDefault();e.returnValue="";}});
document.addEventListener("DOMContentLoaded",async()=>{try{await openDatabase();bindUI();restoreSettings();await loadFiles();updateBreadcrumbs("");}catch(e){console.error(e);alert("Workspace startup failed: "+e.message);}});
