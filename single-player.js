/* RiftCity Static Single Player
   Runs the CURRENT LOCAL RiftCity public/ workspace as a persistent browser sandbox.
   No Cloudflare API, D1, R2, Worker deployment, or GitHub write is used by this mode.

   The service worker supplies a small JSON state bridge at /api/single-player/state.
   RiftCity source can opt into it through window.RiftCitySinglePlayer.
*/
(() => {
  "use strict";

  const TARGET_REPO = "Arctic403/RiftCityV1";
  const EDITOR_BASE_PATH = (() => {
    const path = new URL("./", location.href).pathname;
    return path.endsWith("/") ? path : path + "/";
  })();
  const PREVIEW_PREFIX = EDITOR_BASE_PATH + "__riftcity_single__/";
  const CACHE_NAME = "riftcity-single-player-preview-v1";
  const MAX_FILES = 6000;
  const MAX_BYTES = 120 * 1024 * 1024;
  const SAVE_FILENAME = "riftcity-single-player-save.json";

  const $ = id => document.getElementById(id);

  function repo() { return $("repoSelect")?.value || ""; }
  function branch() { return $("branchSelect")?.value || ""; }

  async function saveDirtyEditor() {
    const editor = $("editor");
    const path = editor?.dataset?.filename || "";
    if (!path || typeof saveFileToDb !== "function") return;
    if (typeof isDirty !== "undefined" && !isDirty) return;
    await saveFileToDb(path, editor.value);
    if (typeof updateDirtyIndicator === "function") updateDirtyIndicator(false);
  }

  function normalizePath(value) {
    const parts = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").split("/");
    const out = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }

  function isSecret(path) {
    const base = normalizePath(path).split("/").pop() || "";
    return /^(?:\.env)(?:\..*)?$/i.test(base)
      || /^(?:\.npmrc|\.pypirc|id_rsa|id_ed25519)$/i.test(base)
      || /\.(?:pem|key|p12|pfx)$/i.test(base);
  }

  function mimeFor(path) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    return ({
      html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
      css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml",
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
      ico: "image/x-icon", txt: "text/plain; charset=utf-8", map: "application/json"
    })[ext] || "application/octet-stream";
  }

  function dataUrlResponse(content, path) {
    const match = String(content).match(/^data:([^;,]+)?;base64,([\s\S]+)$/i);
    if (!match) return null;
    const mime = match[1] || mimeFor(path);
    const bin = atob(match[2].replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, { headers: { "Content-Type": mime, "Cache-Control": "no-store" } });
  }

  async function collectWorkspace() {
    if (typeof getAllWorkspaceFiles !== "function") throw new Error("Workspace read API is unavailable.");
    await saveDirtyEditor();
    const raw = await getAllWorkspaceFiles();
    if (raw.length > MAX_FILES) throw new Error(`Single Player supports up to ${MAX_FILES} files.`);

    const map = new Map();
    let total = 0;
    for (const file of raw) {
      const path = normalizePath(file?.name || "");
      if (!path || path.startsWith(".git/") || path.startsWith("node_modules/") || isSecret(path)) continue;
      const content = typeof file.content === "string" ? file.content : String(file.content ?? "");
      total += content.length;
      if (total > MAX_BYTES) throw new Error("Workspace is too large for browser Single Player.");
      map.set(path, content);
    }
    return map;
  }

  function injectSinglePlayerBridge(html) {
    const script = `<script>
window.__RIFTCITY_SINGLE_PLAYER__=true;
window.__RIFTCITY_SINGLE_PLAYER_PREFIX__=${JSON.stringify(PREVIEW_PREFIX)};
window.RiftCitySinglePlayer=Object.freeze({
  async load(){
    const response=await fetch("/api/single-player/state",{cache:"no-store"});
    const data=await response.json();
    if(!response.ok||!data.ok)throw new Error(data.message||data.error||"Could not load single-player save.");
    return data.state;
  },
  async save(state){
    const response=await fetch("/api/single-player/state",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({state})});
    const data=await response.json();
    if(!response.ok||!data.ok)throw new Error(data.message||data.error||"Could not save single-player state.");
    return data.state;
  },
  async patch(patch){
    const response=await fetch("/api/single-player/state",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({patch})});
    const data=await response.json();
    if(!response.ok||!data.ok)throw new Error(data.message||data.error||"Could not patch single-player state.");
    return data.state;
  },
  async reset(){
    const response=await fetch("/api/single-player/state/reset",{method:"POST"});
    const data=await response.json();
    if(!response.ok||!data.ok)throw new Error(data.message||data.error||"Could not reset single-player state.");
    return data.state;
  }
});
document.addEventListener("click",function(event){
  const anchor=event.target&&event.target.closest&&event.target.closest("a[href]");
  if(!anchor||event.defaultPrevented||anchor.target)return;
  try{
    const url=new URL(anchor.href,location.href);
    if(url.origin!==location.origin||url.pathname.startsWith(${JSON.stringify(PREVIEW_PREFIX)}))return;
    if(url.pathname==="/"){
      event.preventDefault();
      location.href=${JSON.stringify(PREVIEW_PREFIX)}+"index.html"+url.search+url.hash;
    }
  }catch(_){}
},true);
<\/script>`;
    const badge = `<style id="riftcity-single-player-badge">body:after{content:"SINGLE PLAYER · LOCAL SAVE";position:fixed;z-index:2147483647;right:8px;bottom:8px;padding:6px 9px;border-radius:8px;background:rgba(5,18,11,.84);color:#bff7cf;border:1px solid rgba(74,222,128,.48);font:800 10px system-ui;letter-spacing:.07em;pointer-events:none}</style>`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${script}${badge}`);
    return script + badge + html;
  }

  async function populatePreviewCache(files, log) {
    if (!files.has("public/index.html")) throw new Error("RiftCity public/index.html is missing.");
    const publicFiles = [...files.entries()].filter(([path]) => path === "public" || path.startsWith("public/"));
    const cache = await caches.open(CACHE_NAME);
    const old = await cache.keys();
    await Promise.all(old.map(request => cache.delete(request)));

    let count = 0;
    for (const [path, content] of publicFiles) {
      if (path === "public") continue;
      const rel = path.slice("public/".length);
      if (!rel) continue;
      let response = dataUrlResponse(content, rel);
      if (!response) {
        const text = rel === "index.html" ? injectSinglePlayerBridge(content) : content;
        response = new Response(text, { headers: { "Content-Type": mimeFor(rel), "Cache-Control": "no-store" } });
      }
      await cache.put(new Request(location.origin + PREVIEW_PREFIX + rel), response);
      count += 1;
    }
    log(`Prepared ${count} RiftCity public asset(s).`);
  }

  async function ensureServiceWorker(log) {
    if (!("serviceWorker" in navigator)) throw new Error("This browser does not support Service Workers.");
    log("Starting static single-player service worker…");
    const workerUrl = new URL("local-test-sw.js?v=5-pages-single-player", location.href);
    const reg = await navigator.serviceWorker.register(workerUrl.href, { scope: EDITOR_BASE_PATH });
    await navigator.serviceWorker.ready;
    return reg;
  }

  async function workerMessage(type, payload = null) {
    const reg = await navigator.serviceWorker.ready;
    const worker = reg.active || navigator.serviceWorker.controller;
    if (!worker) throw new Error("Single-player service worker is not active.");
    const channel = new MessageChannel();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Single-player service worker did not respond.")), 3000);
      channel.port1.onmessage = event => {
        clearTimeout(timeout);
        if (event.data?.ok === false) reject(new Error(event.data.error || "Single-player request failed."));
        else resolve(event.data);
      };
      worker.postMessage({ type, payload }, [channel.port2]);
    });
  }

  function previewUrl() {
    return location.origin + PREVIEW_PREFIX + "index.html#city";
  }

  function openPreview() {
    window.open(previewUrl(), "_blank", "noopener,noreferrer");
  }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function ensureModal() {
    if ($("singlePlayerModal")) return;
    const style = document.createElement("style");
    style.textContent = `
      .single-player-overlay{position:fixed;inset:0;z-index:211000;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(2,6,12,.80)}
      .single-player-overlay.hidden{display:none}.single-player-card{width:min(700px,100%);max-height:92dvh;overflow:auto;background:#10161f;color:#edf4fb;border:1px solid #335044;border-radius:16px;padding:16px;box-sizing:border-box}
      .single-player-head{display:flex;justify-content:space-between;gap:10px}.single-player-head h2{margin:0;font-size:18px}.single-player-head p{margin:4px 0 0;color:#9eb8aa;font-size:12px}
      .single-player-close{width:38px;height:38px;border:1px solid #435c50;border-radius:9px;background:#18271f;color:white}
      .single-player-note{margin:12px 0;padding:10px;border:1px solid #2d6140;border-radius:10px;background:#0b2415;font-size:12px;line-height:1.5}
      .single-player-status{min-height:92px;padding:10px;border:1px solid #2d4737;border-radius:10px;background:#090f0b;white-space:pre-wrap;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
      .single-player-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.single-player-actions button,.single-player-actions label{flex:1 1 140px;border:0;border-radius:10px;padding:11px 12px;font-weight:800;text-align:center;box-sizing:border-box;cursor:pointer}
      .single-player-run{background:#22c55e;color:#07150b}.single-player-open{background:#26734a;color:white}.single-player-secondary{background:#283b31;color:#e9f8ef}.single-player-danger{background:#63252b;color:#ffd8dc}
      .single-player-actions button:disabled{opacity:.45}
    `;
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    overlay.id = "singlePlayerModal";
    overlay.className = "single-player-overlay hidden";
    overlay.innerHTML = `
      <section class="single-player-card">
        <div class="single-player-head">
          <div><h2>🎮 RiftCity Single Player</h2><p>Static browser runtime with a persistent local JSON save. No Cloudflare required.</p></div>
          <button id="singlePlayerClose" class="single-player-close" type="button">×</button>
        </div>
        <div class="single-player-note">
          <b>GitHub/Pages-ready world sandbox.</b> PREPARE copies the current RiftCity <code>public/</code> tree into a browser cache and runs it behind the Editor service worker. The world stays source-driven, so JSON/JS world edits in the workspace are what the game loads. A namespaced single-player save is kept on this device and is <b>not cleared when you rebuild the preview</b>. This mode never calls production Cloudflare, D1 or R2. Backend-heavy MMO systems that do not have a local adapter remain unavailable instead of being faked.
        </div>
        <div id="singlePlayerStatus" class="single-player-status">Ready.</div>
        <div class="single-player-actions">
          <button id="singlePlayerRun" class="single-player-run" type="button">PREPARE & PLAY</button>
          <button id="singlePlayerOpen" class="single-player-open" type="button">OPEN SAVE</button>
          <button id="singlePlayerExport" class="single-player-secondary" type="button">EXPORT SAVE JSON</button>
          <label class="single-player-secondary">IMPORT SAVE JSON<input id="singlePlayerImportInput" type="file" accept=".json,application/json" hidden></label>
          <button id="singlePlayerReset" class="single-player-danger" type="button">RESET LOCAL SAVE</button>
        </div>
      </section>`;
    document.body.appendChild(overlay);

    $("singlePlayerClose").onclick = () => overlay.classList.add("hidden");
    overlay.addEventListener("click", event => { if (event.target === overlay) overlay.classList.add("hidden"); });
    $("singlePlayerRun").onclick = () => run().catch(error => setStatus("Single Player failed:\n" + (error.message || error)));
    $("singlePlayerOpen").onclick = openPreview;
    $("singlePlayerExport").onclick = async () => {
      try {
        await ensureServiceWorker(() => {});
        const result = await workerMessage("RIFTCITY_SINGLE_EXPORT_STATE");
        downloadJson(SAVE_FILENAME, result.state);
        setStatus("Exported the persistent browser save as JSON.");
      } catch (error) { setStatus("Export failed:\n" + (error.message || error)); }
    };
    $("singlePlayerImportInput").onchange = async event => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try {
        const state = JSON.parse(await file.text());
        await ensureServiceWorker(() => {});
        await workerMessage("RIFTCITY_SINGLE_IMPORT_STATE", state);
        setStatus("Imported single-player save JSON.\nOpen/reload the game to use it.");
      } catch (error) { setStatus("Import failed:\n" + (error.message || error)); }
    };
    $("singlePlayerReset").onclick = async () => {
      if (!confirm("Reset the browser-only RiftCity single-player save on this device? World source files are not changed.")) return;
      try {
        await ensureServiceWorker(() => {});
        await workerMessage("RIFTCITY_SINGLE_RESET_STATE");
        setStatus("Single-player save reset. Workspace/world source files were untouched.");
      } catch (error) { setStatus("Reset failed:\n" + (error.message || error)); }
    };
  }

  function setStatus(text) {
    const node = $("singlePlayerStatus");
    if (node) node.textContent = text;
  }

  async function run() {
    ensureModal();
    if (repo() !== TARGET_REPO) throw new Error(`Select/pull ${TARGET_REPO} first. Current repo: ${repo() || "none"}.`);
    const button = $("singlePlayerRun");
    button.disabled = true;
    const lines = [];
    const log = line => { lines.push(line); setStatus(lines.join("\n")); };
    try {
      log(`Workspace: ${repo()} (${branch() || "local"})`);
      log("Reading current IndexedDB workspace…");
      const workspace = await collectWorkspace();
      log(`Loaded ${workspace.size} workspace file(s).`);
      log("Preparing static RiftCity public/ runtime…");
      await populatePreviewCache(workspace, log);
      await ensureServiceWorker(log);
      log("Persistent local save: preserved.");
      log("Cloudflare/D1/R2: not used.");
      log("Opening Single Player…");
      setTimeout(openPreview, 100);
    } finally {
      button.disabled = false;
    }
  }

  function openModal() {
    ensureModal();
    setStatus(repo() === TARGET_REPO
      ? `Ready for ${repo()} (${branch() || "local"}).\nPREPARE & PLAY uses the current local workspace and preserves the existing browser save.`
      : `Select/pull ${TARGET_REPO} first.\nCurrent repo: ${repo() || "none"}.`);
    $("singlePlayerModal").classList.remove("hidden");
  }

  function bind() {
    ensureModal();
    $("singlePlayerBtn")?.addEventListener("click", openModal);
    window.RiftCitySinglePlayerTest = Object.freeze({ open: openModal, run, openPreview });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
