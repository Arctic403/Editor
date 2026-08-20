const DB_NAME="MobileWorkspaceDB", STORE="files";
let db, activePath="", dirty=false, searchIndex=0, tabs=[], histories=new Map(), savedContents=new Map(), theme="dark";

const $=id=>document.getElementById(id);
const norm=p=>String(p||"").replace(/\\/g,"/").split("/").filter(Boolean).join("/");
const base=p=>norm(p).split("/").pop()||"";
const dir=p=>{let a=norm(p).split("/");a.pop();return a.join("/")};

function openDb(){
  return new Promise((res,rej)=>{
    const r=indexedDB.open(DB_NAME,1);
    r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE,{keyPath:"path"})};
    r.onsuccess=()=>{db=r.result;res()};
    r.onerror=()=>rej(r.error);
  });
}
function tx(mode,fn){
  return new Promise((res,rej)=>{
    if(!db)return rej(new Error("Workspace database is not ready"));
    let t;
    try{
      t=db.transaction(STORE,mode);
      const s=t.objectStore(STORE);
      const out=fn(s);
      t.oncomplete=()=>res(out);
      t.onerror=()=>rej(t.error||new Error("IndexedDB transaction failed"));
      t.onabort=()=>rej(t.error||new Error("IndexedDB transaction aborted"));
    }catch(e){rej(e)}
  });
}
const getAll=()=>tx("readonly",s=>new Promise((res,rej)=>{let r=s.getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)}));
const getFile=p=>tx("readonly",s=>new Promise((res,rej)=>{let r=s.get(norm(p));r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}));
const putFile=(path,content)=>tx("readwrite",s=>s.put({path:norm(path),content:String(content??""),updatedAt:Date.now()}));
const delFile=path=>tx("readwrite",s=>s.delete(norm(path)));

function setDirty(v){
  dirty=!!v;
  $("saveIndicator").className="save-indicator "+(dirty?"dirty":"clean");
  $("saveIndicator").textContent=dirty?"●":"○";
}
function setStatus(message,type="info"){
  const el=$("activeFileLabel");
  if(!activePath){el.textContent=message;return}
  el.textContent=message;
  clearTimeout(setStatus.timer);
  setStatus.timer=setTimeout(()=>{el.textContent=activePath},1800);
}
function reportError(prefix,e){console.error(prefix,e);alert(`${prefix}: ${e?.message||e}`)}

async function renderTree(){
  const files=await getAll();
  $("itemCount").textContent=`${files.length} file${files.length===1?"":"s"}`;

  const make=container=>{
    if(!container)return;
    container.innerHTML="";
    const root={dirs:new Map(),files:[]};

    for(const f of files){
      const parts=norm(f.path).split("/");
      let n=root;
      parts.forEach((x,i)=>{
        if(i===parts.length-1)n.files.push(f);
        else{
          if(!n.dirs.has(x))n.dirs.set(x,{dirs:new Map(),files:[]});
          n=n.dirs.get(x);
        }
      });
    }

    function walk(node,parent,prefix=""){
      [...node.dirs.entries()].sort((a,b)=>a[0].localeCompare(b[0])).forEach(([name,child])=>{
        const wrap=document.createElement("div");
        const row=document.createElement("div");
        const kids=document.createElement("div");
        row.className="tree-row";
        row.innerHTML=`<span class="tree-caret">▸</span><span>📁</span><span class="tree-label">${esc(name)}</span>`;
        kids.className="tree-children hidden";
        row.setAttribute("role","button");
        row.tabIndex=0;
        const toggle=()=>{
          kids.classList.toggle("hidden");
          row.querySelector(".tree-caret").textContent=kids.classList.contains("hidden")?"▸":"▾";
        };
        row.onclick=toggle;
        row.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();toggle()}};
        wrap.append(row,kids);
        parent.append(wrap);
        walk(child,kids,prefix?prefix+"/"+name:name);
      });
      node.files.sort((a,b)=>a.path.localeCompare(b.path)).forEach(f=>{
        const row=document.createElement("div");
        row.className="tree-row";
        row.innerHTML=`<span>📄</span><span class="tree-label">${esc(base(f.path))}</span><button type="button" class="tree-action" title="Delete ${esc(f.path)}" aria-label="Delete ${esc(f.path)}">×</button>`;
        row.onclick=e=>{
          if(e.target.closest("button")){removePath(f.path);return}
          openFile(f.path).catch(e=>reportError("Open failed",e));
        };
        parent.append(row);
      });
    }
    walk(root,container);
  };

  make($("desktopFileTree"));
  make($("fileTree"));
}
async function removePath(path){
  if(!confirm(`Delete ${path}?`))return;
  await delFile(path);
  tabs=tabs.filter(p=>p!==path);
  histories.delete(path);
  savedContents.delete(path);
  if(activePath===path)closeFile();
  renderTabs();
  await renderTree();
}
async function openFile(path){
  if(dirty&&!confirm("Discard unsaved changes?"))return;
  const f=await getFile(path);
  if(!f)return;
  activePath=norm(path);
  $("editor").value=f.content||"";
  $("activeFileLabel").textContent=activePath;
  savedContents.set(activePath,$("editor").value);
  setDirty(false);
  rememberHistory(activePath,$("editor").value,true);
  if(!tabs.includes(activePath))tabs.push(activePath);
  renderTabs();
  updateEditorMeta();
  showEditor();
  closeDrawer();
  searchIndex=0;
}
function closeFile(){
  activePath="";
  $("editor").value="";
  $("activeFileLabel").textContent="No file selected";
  setDirty(false);
  updateEditorMeta();
}
async function save(){
  if(!activePath)return setStatus("No file selected");
  await putFile(activePath,$("editor").value);
  savedContents.set(activePath,$("editor").value);
  setDirty(false);
  await renderTree();
  setStatus("Saved");
}
function updateEditorMeta(){
  const e=$("editor"),lines=e.value.split("\n").length;
  $("lineNumbers").textContent=Array.from({length:Math.max(1,lines)},(_,i)=>i+1).join("\n");
  $("highlightCode").innerHTML=highlight(e.value);
  $("breadcrumbBar").textContent=activePath?"Workspace › "+activePath:"Workspace";
}
function highlight(s){
  return esc(s)
    .replace(/(\/\/.*|\/\*[\s\S]*?\*\/)/g,'<span class="tok-comment">$1</span>')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g,'<span class="tok-string">$&</span>')
    .replace(/\b(const|let|var|function|return|if|else|async|await|class|import|export|from|true|false|null|undefined)\b/g,'<span class="tok-keyword">$1</span>');
}
function syncScroll(){
  const e=$("editor"),h=$("highlightLayer"),n=$("lineNumbers");
  h.scrollTop=e.scrollTop;h.scrollLeft=e.scrollLeft;n.scrollTop=e.scrollTop;
}
function rememberHistory(path,value,reset=false){
  if(!path)return;
  let h=histories.get(path)||{stack:[],i:-1};
  if(reset)h={stack:[value],i:0};
  else if(h.stack[h.i]!==value){
    h.stack=h.stack.slice(0,h.i+1);
    h.stack.push(value);h.i=h.stack.length-1;
    if(h.stack.length>100){h.stack.shift();h.i--}
  }
  histories.set(path,h);
}
function undoRedo(delta){
  const h=histories.get(activePath);if(!h)return;
  const i=Math.max(0,Math.min(h.stack.length-1,h.i+delta));if(i===h.i)return;
  h.i=i;
  $("editor").value=h.stack[i];
  setDirty($("editor").value!==savedContents.get(activePath));
  updateEditorMeta();
}
function renderTabs(){
  $("tabsBar").innerHTML="";
  tabs.forEach(p=>{
    const wrap=document.createElement("div");
    wrap.className="tab-wrap";
    const b=document.createElement("button");
    b.type="button";b.className="editor-tab "+(p===activePath?"active":"");b.textContent=base(p);
    b.title=p;b.onclick=()=>openFile(p).catch(e=>reportError("Open failed",e));
    const x=document.createElement("button");
    x.type="button";x.className="tab-close";x.textContent="×";x.title=`Close ${p}`;
    x.onclick=e=>{e.stopPropagation();closeTab(p)};
    wrap.append(b,x);$("tabsBar").append(wrap);
  });
}
async function closeTab(path){
  if(path===activePath&&dirty&&!confirm("Discard unsaved changes?"))return;
  tabs=tabs.filter(p=>p!==path);
  if(path===activePath){
    const next=tabs[tabs.length-1];
    activePath="";setDirty(false);
    if(next)await openFile(next);else closeFile();
  }
  renderTabs();
}
function showEditor(){$("explorerView").classList.remove("active");$("editorView").classList.add("active")}
function showExplorer(){$("editorView").classList.remove("active");$("explorerView").classList.add("active")}
function openDrawer(){$("mobileDrawer").classList.add("open");$("mobileDrawer").setAttribute("aria-hidden","false");$("drawerScrim").classList.remove("hidden")}
function closeDrawer(){$("mobileDrawer").classList.remove("open");$("mobileDrawer").setAttribute("aria-hidden","true");$("drawerScrim").classList.add("hidden")}
async function createFile(){
  const p=norm(prompt("File path:",activePath?dir(activePath)+"/":"")||"");if(!p)return;
  if(await getFile(p)){alert("Already exists");return}
  await putFile(p,"");await renderTree();await openFile(p);
}
async function createFolder(){
  const p=norm(prompt("Folder name/path:")||"");if(!p)return;
  const file=p+"/.gitkeep";
  if(await getFile(file)){alert("Folder already exists");return}
  await putFile(file,"");await renderTree();
}
function quickOpen(){
  const m=$("quickOpenModal");m.classList.remove("hidden");
  $("quickOpenInput").value="";renderQuick([]);$("quickOpenInput").focus();
}
async function renderQuick(files){
  if(!files.length)files=await getAll();
  const q=$("quickOpenInput").value.toLowerCase();
  $("quickOpenResults").innerHTML="";
  files.filter(f=>f.path.toLowerCase().includes(q)).slice(0,100).forEach(f=>{
    const b=document.createElement("button");b.type="button";b.className="quick-item";b.textContent=f.path;
    b.onclick=()=>{mClose();openFile(f.path).catch(e=>reportError("Open failed",e))};
    $("quickOpenResults").append(b);
  });
}
const mClose=()=>$("quickOpenModal").classList.add("hidden");
function insertText(t){
  const e=$("editor");const a=e.selectionStart,b=e.selectionEnd;
  e.setRangeText(t,a,b,"end");e.focus();e.dispatchEvent(new Event("input"));
}
function downloadCurrent(){
  if(!activePath)return alert("Open a file first");
  const blob=new Blob([$("editor").value],{type:"text/plain;charset=utf-8"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=base(activePath);
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function exportZip(){
  if(!window.JSZip)return alert("ZIP library unavailable");
  const z=new JSZip();for(const f of await getAll())z.file(f.path,f.content);
  const blob=await z.generateAsync({type:"blob"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="workspace.zip";
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function importFiles(list){
  for(const f of [...(list||[])]){
    if(f.name.endsWith(".zip")){
      if(!window.JSZip)throw new Error("ZIP library unavailable");
      const z=await JSZip.loadAsync(f);
      for(const [p,e] of Object.entries(z.files)){
        if(!e.dir)await putFile(p,await e.async("text"));
      }
    }else{
      const path=norm(f.webkitRelativePath||f.name);
      if(path)await putFile(path,await f.text());
    }
  }
  await renderTree();
}
async function searchWorkspace(){
  const q=prompt("Search all files for:");if(!q)return;
  const needle=q.toLowerCase(),out=[];
  for(const f of await getAll()){
    f.content.split("\n").forEach((x,i)=>{if(x.toLowerCase().includes(needle))out.push({p:f.path,i:i+1,x})});
  }
  alert(out.slice(0,100).map(r=>`${r.p}:${r.i}  ${r.x.trim()}`).join("\n")||"No matches");
}
function toggleFullscreen(){
  const a=$("appContainer"),on=a.classList.toggle("fullscreen");
  document.body.classList.toggle("editor-is-fullscreen",on);if(on)showEditor();
}
function ghHeaders(token){return{Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json"}}
function getGitConfig(){
  return{
    token:$("tokenInput").value.trim(),
    repo:$("repoInput").value.trim().replace(/^https?:\/\/github\.com\//,"").replace(/\/+$/,""),
    branch:$("branchInput").value.trim()||"main"
  };
}
async function connectGitHub(){
  const {token,repo,branch}=getGitConfig();
  if(!token)return alert("Enter your GitHub token");
  if(repo&&!/^[^/]+\/[^/]+$/.test(repo))return alert("Repository must look like owner/repository");
  localStorage.setItem("mwe-gh-repo",repo);localStorage.setItem("mwe-gh-branch",branch);
  const r=await fetch("https://api.github.com/user",{headers:ghHeaders(token)});
  if(!r.ok)throw new Error(`GitHub authentication failed (${r.status})`);
  const u=await r.json();
  setStatus(`Connected as ${u.login}`);
  alert(`GitHub connected as ${u.login}`);
}
function decodeBase64Utf8(value){
  const bin=atob(value.replace(/\s/g,""));
  const bytes=Uint8Array.from(bin,c=>c.charCodeAt(0));
  return new TextDecoder("utf-8",{fatal:false}).decode(bytes);
}
function encodeBase64Utf8(value){
  const bytes=new TextEncoder().encode(value);
  let bin="";for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return btoa(bin);
}
async function githubPull(){
  const {token,repo,branch}=getGitConfig();
  if(!token||!repo)return alert("Enter token and owner/repository");
  if(!/^[^/]+\/[^/]+$/.test(repo))return alert("Repository must look like owner/repository");
  const r=await fetch(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,{headers:ghHeaders(token)});
  if(!r.ok)throw new Error(`GitHub pull failed (${r.status})`);
  const data=await r.json();
  if(data.truncated)throw new Error("GitHub returned a truncated tree. Pull a smaller repository or use a narrower branch.");
  const blobs=(data.tree||[]).filter(x=>x.type==="blob");
  for(const x of blobs){
    const b=await fetch(x.url,{headers:ghHeaders(token)});
    if(!b.ok)throw new Error(`Failed to read ${x.path} (${b.status})`);
    const j=await b.json();
    if(j.encoding!=="base64")throw new Error(`Unsupported GitHub encoding for ${x.path}`);
    await putFile(x.path,decodeBase64Utf8(j.content));
  }
  localStorage.setItem("mwe-gh-repo",repo);localStorage.setItem("mwe-gh-branch",branch);
  await renderTree();alert(`Pulled ${blobs.length} files`);
}
async function githubPush(){
  await save();
  const {token,repo,branch}=getGitConfig();
  if(!token||!repo)return alert("Enter token and owner/repository");
  if(!/^[^/]+\/[^/]+$/.test(repo))return alert("Repository must look like owner/repository");
  const msg=prompt("Commit message:","Update mobile workspace")||"Update mobile workspace";
  const files=await getAll();
  for(const f of files){
    const url=`https://api.github.com/repos/${repo}/contents/${f.path.split("/").map(encodeURIComponent).join("/")}`;
    const h=ghHeaders(token);
    const old=await fetch(`${url}?ref=${encodeURIComponent(branch)}`,{headers:h});
    if(!old.ok&&old.status!==404)throw new Error(`Cannot inspect ${f.path} (${old.status})`);
    const body={message:msg,content:encodeBase64Utf8(f.content),branch};
    if(old.ok)body.sha=(await old.json()).sha;
    const r=await fetch(url,{method:"PUT",headers:{...h,"Content-Type":"application/json"},body:JSON.stringify(body)});
    if(!r.ok){
      let detail="";try{detail=(await r.json()).message||""}catch{}
      throw new Error(`Push failed for ${f.path} (${r.status})${detail?": "+detail:""}`);
    }
  }
  localStorage.setItem("mwe-gh-repo",repo);localStorage.setItem("mwe-gh-branch",branch);
  alert(`Commit & push complete — ${files.length} files`);
}
function jumpToLine(){
  const n=Math.floor(Number(prompt("Go to line:")));
  if(!Number.isFinite(n)||n<1)return;
  const e=$("editor"),lines=e.value.split("\n");
  if(n>lines.length)return alert(`File only has ${lines.length} lines`);
  const pos=lines.slice(0,n-1).join("\n").length+(n>1?1:0);
  e.setSelectionRange(pos,pos);e.focus();
}
function bind(){
  $("editor").addEventListener("input",()=>{
    setDirty($("editor").value!==savedContents.get(activePath));
    updateEditorMeta();rememberHistory(activePath,$("editor").value);
  });
  $("editor").addEventListener("scroll",syncScroll);
  $("editor").addEventListener("keydown",e=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){e.preventDefault();save().catch(x=>reportError("Save failed",x))}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="p"){e.preventDefault();quickOpen()}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();undoRedo(e.shiftKey?1:-1)}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="y"){e.preventDefault();undoRedo(1)}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="g"){e.preventDefault();jumpToLine()}
  });

  $("saveLocalBtn").onclick=()=>save().catch(e=>reportError("Save failed",e));
  $("closeFileBtn").onclick=closeFile;
  $("undoBtn").onclick=()=>undoRedo(-1);
  $("redoBtn").onclick=()=>undoRedo(1);
  $("quickOpenBtn").onclick=quickOpen;
  $("jumpLineBtn").onclick=jumpToLine;
  $("searchToggleBtn").onclick=()=>$("searchReplaceBar").classList.toggle("hidden");

  $("findNextBtn").onclick=()=>{
    const e=$("editor"),q=$("searchInput").value;if(!q)return;
    const i=e.value.indexOf(q,searchIndex);
    const next=i<0?e.value.indexOf(q,0):i;
    if(next>=0){e.focus();e.setSelectionRange(next,next+q.length);searchIndex=next+q.length}
  };
  $("searchInput").oninput=()=>{searchIndex=0};
  $("replaceBtn").onclick=()=>{
    const e=$("editor"),q=$("searchInput").value;
    if(!q)return;
    if(e.selectionStart!==e.selectionEnd&&e.value.slice(e.selectionStart,e.selectionEnd)===q)insertText($("replaceInput").value);
  };
  $("replaceAllBtn").onclick=()=>{
    const q=$("searchInput").value;if(!q)return;
    $("editor").value=$("editor").value.split(q).join($("replaceInput").value);
    $("editor").dispatchEvent(new Event("input"));
  };

  $("newFileBtn").onclick=()=>createFile().catch(e=>reportError("Create file failed",e));
  $("newFolderBtn").onclick=()=>createFolder().catch(e=>reportError("Create folder failed",e));
  $("openDrawerBtn").onclick=openDrawer;$("closeDrawerBtn").onclick=closeDrawer;$("drawerScrim").onclick=closeDrawer;
  $("mobileFilesBtn").onclick=openDrawer;
  $("mobileSearchBtn").onclick=()=>searchWorkspace().catch(e=>reportError("Search failed",e));
  $("mobileSaveBtn").onclick=()=>save().catch(e=>reportError("Save failed",e));
  $("mobileGitBtn").onclick=()=>{
    showExplorer();
    const panel=$("configPanel");panel.open=true;
    setTimeout(()=>panel.scrollIntoView({behavior:"smooth",block:"start"}),0);
  };
  $("mobileMoreBtn").onclick=()=>{showExplorer();window.scrollTo(0,0)};

  $("fullscreenBtn").onclick=toggleFullscreen;
  $("downloadFileBtn").onclick=downloadCurrent;
  $("exportWorkspaceBtn").onclick=()=>exportZip().catch(e=>reportError("ZIP export failed",e));
  $("searchWorkspaceBtn").onclick=()=>searchWorkspace().catch(e=>reportError("Search failed",e));
  $("uploadInput").onchange=e=>importFiles(e.target.files).catch(x=>reportError("Import failed",x)).finally(()=>{e.target.value=""});
  $("zipInput").onchange=e=>importFiles(e.target.files).catch(x=>reportError("ZIP import failed",x)).finally(()=>{e.target.value=""});

  $("quickOpenInput").oninput=()=>renderQuick([]).catch(e=>reportError("Quick Open failed",e));
  $("closeQuickOpenModal").onclick=mClose;
  $("quickOpenModal").onclick=e=>{if(e.target===$("quickOpenModal"))mClose()};

  $("themeSelect").onchange=e=>{
    document.body.classList.remove("theme-light","theme-monokai");
    if(e.target.value!=="dark")document.body.classList.add("theme-"+e.target.value);
    localStorage.setItem("mwe-theme",e.target.value);
  };
  $("repoInput").value=localStorage.getItem("mwe-gh-repo")||"";
  $("branchInput").value=localStorage.getItem("mwe-gh-branch")||"main";
  $("repoInput").onchange=()=>localStorage.setItem("mwe-gh-repo",$("repoInput").value.trim().replace(/^https?:\/\/github\.com\//,"").replace(/\/+$/,""));
  $("branchInput").onchange=()=>localStorage.setItem("mwe-gh-branch",$("branchInput").value.trim()||"main");
  $("connectGhBtn").onclick=()=>connectGitHub().catch(e=>reportError("GitHub connection failed",e));
  $("pullGitHubBtn").onclick=()=>githubPull().catch(e=>reportError("GitHub pull failed",e));
  $("pushAllGitHubBtn").onclick=()=>githubPush().catch(e=>reportError("GitHub push failed",e));

  for(const x of ["{","}","(",")","[","]","<",">","=",";","/",":","'","\"","`","_"]){
    const b=document.createElement("button");b.type="button";b.textContent=x;b.title=`Insert ${x}`;
    b.onclick=()=>insertText(x);$("symbolBar").append(b);
  }
}
(async()=>{
  try{
    await openDb();
    const t=localStorage.getItem("mwe-theme")||"dark";
    $("themeSelect").value=["dark","light","monokai"].includes(t)?t:"dark";
    $("themeSelect").dispatchEvent(new Event("change"));
    bind();
    await renderTree();
  }catch(e){console.error(e);alert("Workspace startup failed: "+(e?.message||e))}
})();
