/* RiftCity Browser Local Test
   Fast frontend-only preview of the CURRENT LOCAL IndexedDB workspace.
   No GitHub write. No Cloudflare deployment. No production API access.
*/
(() => {
  "use strict";

  const TARGET_REPO = "Arctic403/RiftCityV1";
  const PREVIEW_PREFIX = "/__riftcity_local__/";
  const CACHE_NAME = "riftcity-local-preview-v2";
  const EDITOR_STATE_CACHE = "riftcity-local-block-editor-state-v2";
  const SOURCE_SCENE_CONFIG_PATH = "public/config/scene-runtime.json";
  const MAX_FILES = 6000;
  const MAX_BYTES = 120 * 1024 * 1024;
  const ESBUILD_URL = "https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.9/esm/browser.min.js";
  const ESBUILD_WASM = "https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.9/esbuild.wasm";
  let esbuildPromise = null;

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

  async function collectWorkspace() {
    if (typeof getAllWorkspaceFiles !== "function") throw new Error("Workspace read API is unavailable.");
    await saveDirtyEditor();
    const raw = await getAllWorkspaceFiles();
    if (raw.length > MAX_FILES) throw new Error(`Local Test supports up to ${MAX_FILES} files.`);

    const map = new Map();
    let total = 0;
    for (const file of raw) {
      const path = normalizePath(file?.name || "");
      if (!path || path.startsWith(".git/") || path.startsWith("node_modules/") || isSecret(path)) continue;
      const content = typeof file.content === "string" ? file.content : String(file.content ?? "");
      total += content.length;
      if (total > MAX_BYTES) throw new Error("Workspace is too large for browser Local Test.");
      map.set(path, content);
    }
    return map;
  }

  async function loadEsbuild() {
    if (esbuildPromise) return esbuildPromise;
    esbuildPromise = (async () => {
      const esbuild = await import(ESBUILD_URL);
      try {
        await esbuild.initialize({ wasmURL: ESBUILD_WASM, worker: true });
      } catch (error) {
        // initialize throws if a previous Editor preview already initialized this module.
        if (!/initialize/i.test(String(error?.message || ""))) throw error;
      }
      return esbuild;
    })();
    return esbuildPromise;
  }

  function resolveVirtual(importer, request, files) {
    if (!request.startsWith(".")) return "";
    const base = importer ? importer.split("/").slice(0, -1).join("/") : "";
    const raw = normalizePath((base ? base + "/" : "") + request);
    const candidates = [
      raw, `${raw}.js`, `${raw}.jsx`, `${raw}.mjs`, `${raw}.json`,
      `${raw}/index.js`, `${raw}/index.jsx`
    ];
    return candidates.find(path => files.has(path)) || "";
  }

  async function buildReactUi(files, log) {
    const entry = "client/react/index.jsx";
    if (!files.has(entry)) {
      log("React entry not present; using existing public/react-ui.js if available.");
      return null;
    }

    log("Browser build: bundling client/react/index.jsx…");
    const esbuild = await loadEsbuild();

    const plugin = {
      name: "riftcity-local-workspace",
      setup(build) {
        build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "pkg" }));
        build.onResolve({ filter: /^react-dom$/ }, () => ({ path: "react-dom", namespace: "pkg" }));
        build.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: "react-dom-client", namespace: "pkg" }));
        build.onResolve({ filter: /^https?:\/\// }, args => ({ path: args.path, external: true }));
        build.onResolve({ filter: /.*/ }, args => {
          if (args.namespace === "pkg") return null;
          if (!args.importer && files.has(normalizePath(args.path))) {
            return { path: normalizePath(args.path), namespace: "ws" };
          }
          const resolved = resolveVirtual(args.importer, args.path, files);
          if (resolved) return { path: resolved, namespace: "ws" };
          return null;
        });
        build.onLoad({ filter: /.*/, namespace: "pkg" }, args => {
          if (args.path === "react") {
            return { contents: 'export * from "https://esm.sh/react@19.1.1"; import d from "https://esm.sh/react@19.1.1"; export default d;', loader: "js" };
          }
          if (args.path === "react-dom-client") {
            return { contents: 'export * from "https://esm.sh/react-dom@19.1.1/client";', loader: "js" };
          }
          return { contents: 'export * from "https://esm.sh/react-dom@19.1.1"; import d from "https://esm.sh/react-dom@19.1.1"; export default d;', loader: "js" };
        });
        build.onLoad({ filter: /.*/, namespace: "ws" }, args => {
          const source = files.get(args.path);
          const ext = args.path.split(".").pop().toLowerCase();
          const loader = ({ jsx: "jsx", js: "js", mjs: "js", json: "json", css: "css" })[ext] || "text";
          return { contents: source, loader, resolveDir: args.path.split("/").slice(0, -1).join("/") };
        });
      }
    };

    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: ["safari16"],
      jsx: "transform",
      sourcemap: "inline",
      plugins: [plugin],
      logLevel: "silent"
    });
    const js = result.outputFiles?.find(file => file.path.endsWith(".js")) || result.outputFiles?.[0];
    if (!js) throw new Error("Browser build produced no React JavaScript.");
    log(`Browser build complete (${Math.round(js.text.length / 1024)} KiB).`);
    return js.text;
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

  function mimeFor(path) {
    const ext = path.split(".").pop().toLowerCase();
    return ({
      html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
      css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml",
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
      ico: "image/x-icon", txt: "text/plain; charset=utf-8", map: "application/json"
    })[ext] || "application/octet-stream";
  }

  function injectPreviewBanner(html) {
    const script = `<script>
window.__RIFTCITY_LOCAL_TEST__=true;
window.__RIFTCITY_LOCAL_TEST_PREFIX__=${JSON.stringify(PREVIEW_PREFIX)};
document.addEventListener("click",function(event){
  const anchor=event.target?.closest?.("a[href]");
  if(!anchor||event.defaultPrevented||anchor.target)return;
  try{
    const url=new URL(anchor.href,location.href);
    if(url.origin!==location.origin||url.pathname.startsWith(PREVIEW_PREFIX))return;
    if(url.pathname==="/dev/block-editor"||url.pathname==="/dev/block-editor/"){
      event.preventDefault();
      location.href=PREVIEW_PREFIX+"dev/block-editor"+url.search+url.hash;
      return;
    }
    if(url.pathname==="/"){
      event.preventDefault();
      location.href=PREVIEW_PREFIX+"index.html"+url.search+url.hash;
    }
  }catch(_){}
},true);
<\/script>`;
    const banner = `<style id="riftcity-local-test-badge">body:after{content:"LOCAL FRONTEND TEST";position:fixed;z-index:2147483647;right:8px;bottom:8px;padding:6px 9px;border-radius:8px;background:rgba(5,12,20,.82);color:#b9e6ff;border:1px solid rgba(125,211,252,.45);font:700 10px system-ui;letter-spacing:.08em;pointer-events:none}</style>`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${script}${banner}`);
    return script + banner + html;
  }

  async function populatePreviewCache(files, reactBundle, log) {
    const publicFiles = [...files.entries()].filter(([path]) => path === "public" || path.startsWith("public/"));
    if (!files.has("public/index.html")) throw new Error("RiftCity public/index.html is missing.");

    const cache = await caches.open(CACHE_NAME);
    const old = await cache.keys();
    await Promise.all(old.map(req => cache.delete(req)));

    let count = 0;
    for (const [path, content] of publicFiles) {
      if (path === "public") continue;
      const rel = path.slice("public/".length);
      if (!rel) continue;
      let response = dataUrlResponse(content, rel);
      if (!response) {
        let text = content;
        if (rel === "index.html") text = injectPreviewBanner(text);
        if (rel === "react-ui.js" && reactBundle) text = reactBundle;
        response = new Response(text, { headers: { "Content-Type": mimeFor(rel), "Cache-Control": "no-store" } });
      }
      await cache.put(new Request(location.origin + PREVIEW_PREFIX + rel), response);
      count++;
    }

    if (reactBundle && !files.has("public/react-ui.js")) {
      await cache.put(
        new Request(location.origin + PREVIEW_PREFIX + "react-ui.js"),
        new Response(reactBundle, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } })
      );
      count++;
    }

    log(`Prepared ${count} public asset(s) in the browser preview cache.`);
  }

  async function ensureServiceWorker(log) {
    if (!("serviceWorker" in navigator)) throw new Error("This browser does not support Service Workers.");
    log("Starting local preview service worker…");
    const reg = await navigator.serviceWorker.register("/local-test-sw.js?v=3-scene-config", { scope: "/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      log("Service worker installed. Activating preview without reloading the Editor…");
    }
    return reg;
  }

  async function resetLocalEditorState(reg, log) {
    const worker = reg?.active || navigator.serviceWorker.controller;
    if (!worker) return;
    const channel = new MessageChannel();
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 1200);
      channel.port1.onmessage = () => {
        clearTimeout(timeout);
        resolve();
      };
      worker.postMessage({ type: "RIFTCITY_LOCAL_RESET_EDITOR_STATE" }, [channel.port2]);
    });
    log("Local Block Editor scene-config state reset for this build.");
  }

  function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function sourceConfigUrlToSceneId(url) {
    try {
      const path = new URL(url, location.origin).pathname;
      const prefix = PREVIEW_PREFIX + "__editor_state__/blocks/";
      if (!path.startsWith(prefix) || !path.endsWith(".json")) return "";
      return decodeURIComponent(path.slice(prefix.length, -5));
    } catch (_) {
      return "";
    }
  }

  async function collectPublishedLocalSceneConfigs() {
    const cache = await caches.open(EDITOR_STATE_CACHE);
    const requests = await cache.keys();
    const scenes = [];

    for (const request of requests) {
      const sceneId = sourceConfigUrlToSceneId(request.url);
      if (!sceneId) continue;
      const response = await cache.match(request);
      if (!response) continue;
      let state;
      try { state = await response.json(); }
      catch (_) { continue; }
      const runtimeConfig = state?.published?.runtimeConfig;
      if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) continue;
      if (Number(runtimeConfig.schemaVersion ?? 1) !== 1) {
        throw new Error(`Published Local Test config for ${sceneId} uses an unsupported schema version.`);
      }
      scenes.push({
        id: String(state?.published?.id || sceneId),
        runtimeConfig: cloneJson(runtimeConfig),
        revision: Number(state?.publishedRevision || 0),
        integrity: cloneJson(state?.integrity || null)
      });
    }

    scenes.sort((a, b) => a.id.localeCompare(b.id));
    return scenes;
  }

  async function currentWorkspaceFile(path) {
    if (typeof getAllWorkspaceFiles !== "function") throw new Error("Workspace read API is unavailable.");
    const files = await getAllWorkspaceFiles();
    return files.find(file => normalizePath(file?.name || "") === path) || null;
  }

  function parseSceneSourceConfig(text) {
    if (!String(text || "").trim()) return { schemaVersion: 1, scenes: {} };
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (error) { throw new Error(`${SOURCE_SCENE_CONFIG_PATH} is not valid JSON: ${error.message}`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${SOURCE_SCENE_CONFIG_PATH} must contain one JSON object.`);
    }
    if (parsed.schemaVersion != null && Number(parsed.schemaVersion) !== 1) {
      throw new Error(`${SOURCE_SCENE_CONFIG_PATH} uses an unsupported schemaVersion.`);
    }
    if (parsed.scenes != null && (typeof parsed.scenes !== "object" || Array.isArray(parsed.scenes))) {
      throw new Error(`${SOURCE_SCENE_CONFIG_PATH} scenes must be an object.`);
    }
    return { ...parsed, schemaVersion: 1, scenes: { ...(parsed.scenes || {}) } };
  }

  async function savePublishedConfigToWorkspace() {
    if (repo() !== TARGET_REPO) {
      throw new Error(`Select/pull ${TARGET_REPO} first. Current repo: ${repo() || "none"}.`);
    }
    if (typeof saveFileToDb !== "function") throw new Error("Workspace write API is unavailable.");

    await saveDirtyEditor();
    const publishedScenes = await collectPublishedLocalSceneConfigs();
    if (!publishedScenes.length) {
      throw new Error("No Local Test scene has a published runtime config yet. Publish the scene in the Local Block Editor first.");
    }

    const existing = await currentWorkspaceFile(SOURCE_SCENE_CONFIG_PATH);
    const sourceConfig = parseSceneSourceConfig(existing?.content || "");
    for (const scene of publishedScenes) {
      const previous = sourceConfig.scenes[scene.id];
      sourceConfig.scenes[scene.id] = {
        ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}),
        runtimeConfig: cloneJson(scene.runtimeConfig)
      };
    }

    const sortedScenes = {};
    for (const sceneId of Object.keys(sourceConfig.scenes).sort()) sortedScenes[sceneId] = sourceConfig.scenes[sceneId];
    sourceConfig.scenes = sortedScenes;
    const nextText = JSON.stringify(sourceConfig, null, 2) + "\n";
    const oldText = typeof existing?.content === "string" ? existing.content : String(existing?.content ?? "");
    if (oldText === nextText) {
      return { changed: false, path: SOURCE_SCENE_CONFIG_PATH, scenes: publishedScenes };
    }

    if (typeof ensureFolderPath === "function") await ensureFolderPath("public/config");
    await saveFileToDb(SOURCE_SCENE_CONFIG_PATH, nextText);
    const editor = $("editor");
    if (editor?.dataset?.filename === SOURCE_SCENE_CONFIG_PATH) {
      editor.value = nextText;
      if (typeof updateDirtyIndicator === "function") updateDirtyIndicator(false);
    }
    if (typeof loadFiles === "function") await loadFiles();
    if (typeof scheduleGitSyncStatusUpdate === "function") scheduleGitSyncStatusUpdate();

    return { changed: true, path: SOURCE_SCENE_CONFIG_PATH, scenes: publishedScenes };
  }

  function ensureModal() {
    if ($("localTestModal")) return;
    const style = document.createElement("style");
    style.textContent = `
      .local-test-overlay{position:fixed;inset:0;z-index:210000;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(2,6,12,.78)}
      .local-test-overlay.hidden{display:none}.local-test-card{width:min(680px,100%);max-height:92dvh;overflow:auto;background:#10161f;color:#edf4fb;border:1px solid #334153;border-radius:16px;padding:16px;box-sizing:border-box}
      .local-test-head{display:flex;justify-content:space-between;gap:10px}.local-test-head h2{margin:0;font-size:18px}.local-test-head p{margin:4px 0 0;color:#9eb0c2;font-size:12px}
      .local-test-close{width:38px;height:38px;border:1px solid #435064;border-radius:9px;background:#192331;color:white}.local-test-note{margin:12px 0;padding:10px;border:1px solid #37516d;border-radius:10px;background:#0c2132;font-size:12px;line-height:1.45}
      .local-test-status{min-height:92px;padding:10px;border:1px solid #2d3847;border-radius:10px;background:#090d13;white-space:pre-wrap;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
      .local-test-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.local-test-actions button{flex:1 1 145px;border:0;border-radius:10px;padding:11px 12px;font-weight:800}
      .local-test-run{background:#22c55e;color:#07150b}.local-test-open{background:#2d78ff;color:white}.local-test-save-config{background:#d99a2b;color:#171006;flex-basis:100%!important}
    `;
    document.head.appendChild(style);
    const overlay = document.createElement("div");
    overlay.id = "localTestModal";
    overlay.className = "local-test-overlay hidden";
    overlay.innerHTML = `
      <section class="local-test-card">
        <div class="local-test-head"><div><h2>⚡ RiftCity Local Test</h2><p>Browser build + local preview. No GitHub. No Cloudflare deployment.</p></div><button id="localTestClose" class="local-test-close">×</button></div>
        <div class="local-test-note"><b>Frontend-only safety mode.</b> City/alley gameplay and the private Block Editor run entirely from the current browser workspace. The preview supplies a fake developer session plus browser-local draft/publish/history mocks, including the current scene runtimeConfig. Local publish mirrors the Worker schema checks and stores a local SHA-256 integrity envelope, but never pretends to perform production D1/HMAC signing. <b>SAVE PUBLISHED CONFIG TO WORKSPACE</b> is the only Local Test action here that writes source data: it copies locally published scene runtimeConfig values into <code>public/config/scene-runtime.json</code> in the current RiftCity browser workspace. GitHub is still untouched until you use the normal Push Changes flow. Rebuilding Local Test clears only the mocked publish database, not source files.</div>
        <div id="localTestStatus" class="local-test-status">Ready.</div>
        <div class="local-test-actions">
          <button id="localTestRun" class="local-test-run">BUILD & OPEN GAME</button>
          <button id="localTestRunEditor" class="local-test-run">BUILD & OPEN EDITOR</button>
          <button id="localTestOpen" class="local-test-open">OPEN GAME</button>
          <button id="localTestOpenEditor" class="local-test-open">OPEN BLOCK EDITOR</button>
          <button id="localTestSaveConfig" class="local-test-save-config">SAVE PUBLISHED CONFIG TO WORKSPACE</button>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    $("localTestClose").onclick = () => overlay.classList.add("hidden");
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.add("hidden"); });
    $("localTestRun").onclick = () => run("city").catch(error => setStatus("Local Test failed:\n" + (error.message || error)));
    $("localTestRunEditor").onclick = () => run("editor").catch(error => setStatus("Local Test failed:\n" + (error.message || error)));
    $("localTestOpen").onclick = () => openPreview("city");
    $("localTestOpenEditor").onclick = () => openPreview("editor");
    $("localTestSaveConfig").onclick = async () => {
      const button = $("localTestSaveConfig");
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = "SAVING CONFIG…";
      try {
        const result = await savePublishedConfigToWorkspace();
        const names = result.scenes.map(scene => `${scene.id} (local r${scene.revision || 0})`).join(", ");
        setStatus(result.changed
          ? `Saved ${result.scenes.length} published scene config(s) to ${result.path}.\n${names}\n\nThis changed only the local RiftCity workspace. Use Push Changes when you want it in GitHub.`
          : `Source config is already current in ${result.path}.\n${names}`);
      } catch (error) {
        setStatus("Save config failed:\n" + (error.message || error));
      } finally {
        button.disabled = false;
        button.textContent = oldText;
      }
    };
  }

  function setStatus(text) {
    const node = $("localTestStatus");
    if (node) node.textContent = text;
  }

  function previewUrl(target = "city") {
    return location.origin + PREVIEW_PREFIX + (target === "editor" ? "dev/block-editor" : "index.html#city");
  }

  function openPreview(target = "city") {
    window.open(previewUrl(target), "_blank");
  }

  async function run(target = "city") {
    ensureModal();
    if (repo() !== TARGET_REPO) throw new Error(`Select/pull ${TARGET_REPO} first. Current repo: ${repo() || "none"}.`);

    const buttons = [$("localTestRun"), $("localTestRunEditor")].filter(Boolean);
    buttons.forEach(button => { button.disabled = true; });
    const lines = [];
    const log = line => {
      lines.push(line);
      setStatus(lines.join("\n"));
    };

    try {
      log(`Workspace: ${repo()} (${branch() || "local"})`);
      log("Reading current IndexedDB files…");
      const files = await collectWorkspace();
      log(`Loaded ${files.size} workspace file(s).`);

      let reactBundle = null;
      try {
        reactBundle = await buildReactUi(files, log);
      } catch (error) {
        if (!files.has("public/react-ui.js")) throw error;
        log("React browser build failed; falling back to existing public/react-ui.js.");
        log("Build warning: " + (error.message || error));
      }

      await populatePreviewCache(files, reactBundle, log);
      const reg = await ensureServiceWorker(log);
      await resetLocalEditorState(reg, log);
      log("Local frontend preview ready.");
      log(target === "editor" ? "Opening private Block Editor…" : "Opening RiftCity…");
      setTimeout(() => openPreview(target), 100);
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  function openModal() {
    ensureModal();
    setStatus(repo() === TARGET_REPO
      ? `Ready for ${repo()} (${branch() || "local"}).\nBUILD & OPEN uses the current local workspace.`
      : `Select/pull ${TARGET_REPO} first.\nCurrent repo: ${repo() || "none"}.`);
    $("localTestModal").classList.remove("hidden");
  }

  function bind() {
    ensureModal();
    $("localTestBtn")?.addEventListener("click", openModal);
    window.RiftCityLocalTest = Object.freeze({
      open: openModal,
      run,
      openPreview,
      openEditor: () => openPreview("editor"),
      savePublishedConfigToWorkspace
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
