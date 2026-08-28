/* RiftCity browser Local Test service worker.
   Passes the Editor through untouched and serves only preview clients from Cache Storage.

   Local Test is intentionally NOT a backend emulator:
   - it provides only the minimum safe GET/bootstrap responses required to enter RiftCity;
   - authoritative mutations stay blocked;
   - production Worker, D1 and R2 are never contacted by preview API requests.
*/
const CACHE_NAME = "riftcity-local-preview-v2";
const SINGLE_CACHE_NAME = "riftcity-single-player-preview-v1";
const SINGLE_STATE_CACHE = "riftcity-single-player-state-v1";
const BASE_PATH = (() => {
  const path = new URL(self.registration.scope).pathname;
  return path.endsWith("/") ? path : path + "/";
})();
const PREFIX = BASE_PATH + "__riftcity_local__/";
const SINGLE_PREFIX = BASE_PATH + "__riftcity_single__/";
const EDITOR_STATE_CACHE = "riftcity-local-block-editor-state-v2";

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));

self.addEventListener("message", event => {
  const type = event.data?.type;
  const port = event.ports?.[0];
  if (type === "RIFTCITY_LOCAL_RESET_EDITOR_STATE") {
    event.waitUntil((async () => {
      await clearBlockEditorState();
      try { port?.postMessage({ ok: true }); } catch (_) {}
    })());
    return;
  }
  if (type === "RIFTCITY_SINGLE_RESET_STATE") {
    event.waitUntil((async () => {
      await caches.delete(SINGLE_STATE_CACHE);
      const state = await loadSingleState();
      try { port?.postMessage({ ok: true, state }); } catch (_) {}
    })());
    return;
  }
  if (type === "RIFTCITY_SINGLE_EXPORT_STATE") {
    event.waitUntil((async () => {
      const state = await loadSingleState();
      try { port?.postMessage({ ok: true, state }); } catch (_) {}
    })());
    return;
  }
  if (type === "RIFTCITY_SINGLE_IMPORT_STATE") {
    event.waitUntil((async () => {
      try {
        const state = normalizeImportedSingleState(event.data?.payload);
        await saveSingleState(state);
        port?.postMessage({ ok: true, state });
      } catch (error) {
        try { port?.postMessage({ ok: false, error: String(error?.message || error) }); } catch (_) {}
      }
    })());
  }
});

self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-RiftCity-Local-Test": "1"
    }
  });
}

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function safeBlockId(value) {
  const id = decodeURIComponent(String(value || ""));
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id)) throw new Error("Invalid local block id.");
  return id;
}

function blockStateUrl(id) {
  return self.location.origin + PREFIX + "__editor_state__/blocks/" + encodeURIComponent(id) + ".json";
}

function freshBlockState(id) {
  return {
    id,
    draft: null,
    published: null,
    draftRevision: 0,
    publishedRevision: 0,
    publishedAt: null,
    integrity: null,
    history: []
  };
}

async function loadBlockState(id) {
  const cache = await caches.open(EDITOR_STATE_CACHE);
  const response = await cache.match(blockStateUrl(id));
  if (!response) return freshBlockState(id);
  try {
    return { ...freshBlockState(id), ...(await response.json()) };
  } catch (_) {
    return freshBlockState(id);
  }
}

async function saveBlockState(state) {
  const cache = await caches.open(EDITOR_STATE_CACHE);
  await cache.put(
    blockStateUrl(state.id),
    new Response(JSON.stringify(state), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    })
  );
}

async function clearBlockEditorState() {
  await Promise.all([
    caches.delete(EDITOR_STATE_CACHE),
    caches.delete("riftcity-local-block-editor-state-v1")
  ]);
}

async function readJson(request) {
  try { return await request.clone().json(); }
  catch (_) { return null; }
}

const LOCAL_RUNTIME_CONFIG_LIMITS = Object.freeze({
  camera: Object.freeze({
    playScale: [.05, 3], zoom: [.05, 3], minScale: [.05, 3], maxScale: [.05, 3],
    anchorX: [0, 1], anchorY: [0, 1], lookAhead: [0, 1200],
    positionEase: [.01, 1], zoomEase: [.01, 1]
  }),
  player: Object.freeze({
    baseScale: [.30, 4], editorScale: [.30, 4], depthMin: [.20, 3], depthMax: [.20, 3],
    visualOffsetX: [-500, 500], visualOffsetY: [-500, 500], shadowScale: [.20, 4]
  }),
  movement: Object.freeze({ walkSpeed: [40, 800], runSpeed: [60, 1200], maxStep: [2, 24] }),
  interaction: Object.freeze({ radius: [20, 500], roomExitRadius: [20, 500] })
});

function knownKeysOnly(value, allowed, label) {
  if (value == null) return "";
  if (typeof value !== "object" || Array.isArray(value)) return `${label} must be an object.`;
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  return unknown ? `${label} contains unsupported field ${unknown}.` : "";
}

function finiteInRange(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}

function validateRuntimeConfig(config) {
  if (config == null) return "";
  if (typeof config !== "object" || Array.isArray(config)) return "runtimeConfig must be an object.";
  let error = knownKeysOnly(config, new Set(["schemaVersion", "camera", "player", "movement", "interaction"]), "runtimeConfig");
  if (error) return error;
  if (config.schemaVersion != null && Number(config.schemaVersion) !== 1) return "Unsupported runtimeConfig schemaVersion.";

  if (config.camera != null) {
    const allowed = new Set(["mode", "playScale", "zoom", "minScale", "maxScale", "anchorX", "anchorY", "lookAhead", "vertical", "positionEase", "zoomEase"]);
    error = knownKeysOnly(config.camera, allowed, "runtimeConfig.camera");
    if (error) return error;
    if (config.camera.mode != null && !["follow", "contain", "cover", "room"].includes(String(config.camera.mode))) return "Invalid runtimeConfig.camera mode.";
    if (config.camera.vertical != null && !["follow", "ground"].includes(String(config.camera.vertical))) return "Invalid runtimeConfig.camera vertical mode.";
    for (const [key, range] of Object.entries(LOCAL_RUNTIME_CONFIG_LIMITS.camera)) {
      if (config.camera[key] != null && !finiteInRange(config.camera[key], range[0], range[1])) return `Invalid runtimeConfig.camera ${key}.`;
    }
    if (config.camera.minScale != null && config.camera.maxScale != null && Number(config.camera.minScale) > Number(config.camera.maxScale)) return "runtimeConfig.camera minScale cannot exceed maxScale.";
  }

  if (config.player != null) {
    error = knownKeysOnly(config.player, new Set(["baseScale", "editorScale", "depthMin", "depthMax", "visualOffsetX", "visualOffsetY", "shadowScale"]), "runtimeConfig.player");
    if (error) return error;
    for (const [key, range] of Object.entries(LOCAL_RUNTIME_CONFIG_LIMITS.player)) {
      if (config.player[key] != null && !finiteInRange(config.player[key], range[0], range[1])) return `Invalid runtimeConfig.player ${key}.`;
    }
    if (config.player.depthMin != null && config.player.depthMax != null && Number(config.player.depthMin) > Number(config.player.depthMax)) return "runtimeConfig.player depthMin cannot exceed depthMax.";
  }

  if (config.movement != null) {
    error = knownKeysOnly(config.movement, new Set(["walkSpeed", "runSpeed", "maxStep"]), "runtimeConfig.movement");
    if (error) return error;
    for (const [key, range] of Object.entries(LOCAL_RUNTIME_CONFIG_LIMITS.movement)) {
      if (config.movement[key] != null && !finiteInRange(config.movement[key], range[0], range[1])) return `Invalid runtimeConfig.movement ${key}.`;
    }
    if (config.movement.walkSpeed != null && config.movement.runSpeed != null && Number(config.movement.runSpeed) < Number(config.movement.walkSpeed)) return "runtimeConfig.movement runSpeed cannot be lower than walkSpeed.";
  }

  if (config.interaction != null) {
    error = knownKeysOnly(config.interaction, new Set(["radius", "roomExitRadius"]), "runtimeConfig.interaction");
    if (error) return error;
    for (const [key, range] of Object.entries(LOCAL_RUNTIME_CONFIG_LIMITS.interaction)) {
      if (config.interaction[key] != null && !finiteInRange(config.interaction[key], range[0], range[1])) return `Invalid runtimeConfig.interaction ${key}.`;
    }
  }
  return "";
}

function validateLocalBlock(block, expectedId) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return "Draft body must include a block object.";
  if (String(block.id || "") !== String(expectedId || "")) return "Block id does not match the Local Test route.";
  return validateRuntimeConfig(block.runtimeConfig);
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function localIntegrity(block, revision, signedAt = Date.now()) {
  const canonical = JSON.stringify(block);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return {
    verified: true,
    revision: Number(revision || 0),
    sha256: bytesToHex(new Uint8Array(digest)),
    signature: null,
    algorithm: "local-sha256-v1",
    signedAt,
    localTest: true
  };
}

async function mockBlockApi(request, path) {
  const method = request.method.toUpperCase();

  const publicMatch = path.match(/^\/api\/world\/blocks\/([^/]+)$/);
  if (publicMatch && method === "GET") {
    const id = safeBlockId(publicMatch[1]);
    const state = await loadBlockState(id);
    if (!state.published) {
      return json({
        ok: true,
        blockId: id,
        published: false,
        revision: 0,
        publishedAt: null,
        block: null,
        integrity: null,
        message: "No browser-local published layout yet; using the current workspace source.",
        localTest: true
      });
    }
    const integrity = state.integrity || await localIntegrity(state.published, state.publishedRevision, state.publishedAt || Date.now());
    if (!state.integrity) { state.integrity = integrity; await saveBlockState(state); }
    return json({
      ok: true,
      blockId: id,
      published: true,
      revision: state.publishedRevision,
      publishedRevision: state.publishedRevision,
      publishedAt: state.publishedAt || null,
      block: cloneJson(state.published),
      integrity: cloneJson(integrity),
      localTest: true
    });
  }

  const adminMatch = path.match(/^\/api\/admin\/blocks\/([^/]+)\/(editor|draft|publish|revert-draft|history|restore-revision)$/);
  if (!adminMatch) return null;

  const id = safeBlockId(adminMatch[1]);
  const action = adminMatch[2];
  const state = await loadBlockState(id);

  if (action === "editor" && method === "GET") {
    return json({
      ok: true,
      draft: cloneJson(state.draft),
      published: cloneJson(state.published),
      draftRevision: state.draftRevision,
      publishedRevision: state.publishedRevision,
      publishedAt: state.publishedAt || null,
      integrity: cloneJson(state.integrity),
      localTest: true
    });
  }

  if (action === "draft" && method === "PUT") {
    const body = await readJson(request);
    const validationError = validateLocalBlock(body?.block, id);
    if (validationError) {
      return json({ ok: false, error: "LOCAL_INVALID_BLOCK", message: validationError }, 400);
    }
    state.draft = cloneJson(body.block);
    state.draftRevision = Number(state.draftRevision || 0) + 1;
    await saveBlockState(state);
    return json({
      ok: true,
      blockId: id,
      draftRevision: state.draftRevision,
      publishedRevision: state.publishedRevision,
      savedAt: Date.now(),
      block: cloneJson(state.draft),
      localTest: true
    });
  }

  if (action === "publish" && method === "POST") {
    if (!state.draft) {
      return json({ ok: false, error: "LOCAL_NO_DRAFT", message: "Save a Local Test draft before publishing." }, 409);
    }
    const validationError = validateLocalBlock(state.draft, id);
    if (validationError) return json({ ok: false, error: "LOCAL_INVALID_BLOCK", message: validationError }, 400);
    state.published = cloneJson(state.draft);
    state.publishedRevision = Number(state.publishedRevision || 0) + 1;
    state.draftRevision = Math.max(Number(state.draftRevision || 0), state.publishedRevision);
    state.publishedAt = Date.now();
    state.integrity = await localIntegrity(state.published, state.publishedRevision, state.publishedAt);
    state.history.unshift({
      revision: state.publishedRevision,
      published_at: state.publishedAt,
      block: cloneJson(state.published),
      integrity: cloneJson(state.integrity)
    });
    state.history = state.history.slice(0, 30);
    await saveBlockState(state);
    return json({
      ok: true,
      blockId: id,
      block: cloneJson(state.published),
      publishedRevision: state.publishedRevision,
      publishedAt: state.publishedAt,
      draftRevision: state.draftRevision,
      integrity: cloneJson(state.integrity),
      localTest: true
    });
  }

  if (action === "revert-draft" && method === "POST") {
    state.draft = state.published ? cloneJson(state.published) : null;
    state.draftRevision = Number(state.draftRevision || 0) + 1;
    await saveBlockState(state);
    return json({
      ok: true,
      block: cloneJson(state.draft),
      draftRevision: state.draftRevision,
      publishedRevision: state.publishedRevision,
      revertedTo: state.published ? `local published r${state.publishedRevision}` : "workspace source fallback",
      localTest: true
    });
  }

  if (action === "history" && method === "GET") {
    return json({
      ok: true,
      history: state.history.map(item => ({
        revision: item.revision,
        published_at: item.published_at,
        integrity_algorithm: item.integrity?.algorithm || null,
        integrity_sha256: item.integrity?.sha256 || null
      })),
      localTest: true
    });
  }

  if (action === "restore-revision" && method === "POST") {
    const body = await readJson(request);
    const revision = Number(body?.revision || 0);
    const found = state.history.find(item => Number(item.revision) === revision);
    if (!found) return json({ ok: false, error: "LOCAL_REVISION_NOT_FOUND" }, 404);
    state.draft = cloneJson(found.block);
    state.draftRevision = Number(state.draftRevision || 0) + 1;
    await saveBlockState(state);
    return json({
      ok: true,
      blockId: id,
      restoredRevision: revision,
      block: cloneJson(state.draft),
      draftRevision: state.draftRevision,
      publishedRevision: state.publishedRevision,
      integrity: cloneJson(found.integrity || null),
      localTest: true
    });
  }

  return json({
    ok: false,
    error: "LOCAL_METHOD_NOT_ALLOWED",
    message: `Local Block Editor mock does not support ${method} ${path}.`
  }, 405);
}

function localBlockEditorPage() {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no">
  <meta name="theme-color" content="#061014">
  <meta name="robots" content="noindex,nofollow">
  <title>RiftCity — Local Block Editor</title>
  <link rel="stylesheet" href="${PREFIX}styles.css">
  <style>body:after{content:"LOCAL BLOCK EDITOR";position:fixed;z-index:2147483647;right:8px;bottom:8px;padding:6px 9px;border-radius:8px;background:rgba(5,12,20,.84);color:#b9e6ff;border:1px solid rgba(125,211,252,.45);font:700 10px system-ui;letter-spacing:.08em;pointer-events:none}</style>
  <script>
  window.__RIFTCITY_LOCAL_TEST__=true;
  window.__RIFTCITY_LOCAL_TEST_PREFIX__=${JSON.stringify(PREFIX)};
  document.addEventListener("click",function(event){
    const anchor=event.target&&event.target.closest&&event.target.closest("a[href]");
    if(!anchor||event.defaultPrevented||anchor.target)return;
    try{
      const url=new URL(anchor.href,location.href);
      if(url.origin!==location.origin||url.pathname.startsWith(${JSON.stringify(PREFIX)}))return;
      if(url.pathname==="/"){
        event.preventDefault();
        location.href=${JSON.stringify(PREFIX)}+"index.html"+url.search+url.hash;
      }else if(url.pathname==="/dev/block-editor"||url.pathname==="/dev/block-editor/"){
        event.preventDefault();
        location.href=${JSON.stringify(PREFIX)}+"dev/block-editor"+url.search+url.hash;
      }
    }catch(_){}
  },true);
  </script>
</head>
<body class="dev-block-editor-page">
  <main id="dev-block-editor-root" aria-label="RiftCity Local Block Editor">
    <div class="dev-editor-loading"><strong>BLOCK EDITOR</strong><span>Loading local workspace…</span></div>
  </main>
  <script type="module">
import { renderDeveloperBlockEditor, destroyBlockWorld } from '${PREFIX}editor/block-editor-entry.js';
const root=document.querySelector('#dev-block-editor-root');
async function boot(){
  const response=await fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!['admin','developer'].includes(data&&data.user&&data.user.role)){
    root.innerHTML='<section class="dev-editor-denied"><strong>Developer access required</strong><a href="/">Return to RiftCity</a></section>';
    return;
  }
  document.documentElement.classList.add('dev-block-editor-document');
  await renderDeveloperBlockEditor(root);
}
window.addEventListener('pagehide',()=>destroyBlockWorld(),{once:true});
boot().catch(error=>{
  console.error(error);
  root.innerHTML='<section class="dev-editor-denied"><strong>Block Editor failed to start</strong><small style="display:block;margin-top:8px">'+String(error&&error.message||error)+'</small><a href="/">Return to RiftCity</a></section>';
});
  </script>
</body>
</html>`, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-RiftCity-Local-Test": "1",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}

function localPlayer() {
  return {
    id: "local-test-player",
    userId: "local-test-user",
    username: "LocalTester",
    level: 12,
    xp: 0,
    cash: 25000,
    bank: 0,
    health: 100,
    maxHealth: 100,
    energy: 100,
    maxEnergy: 100,
    nerve: 25,
    maxNerve: 25,
    strength: 25,
    speed: 25,
    defense: 25,
    dexterity: 25,
    heat: 0,
    locationId: "downtown",
    location_id: "downtown",
    status: "active",
    resources: {
      health: { current: 100, max: 100 },
      energy: { current: 100, max: 100 },
      nerve: { current: 25, max: 25 },
      regen: {}
    }
  };
}

function localUser() {
  return {
    id: "local-test-user",
    username: "LocalTester",
    role: "developer",
    isAdmin: true,
    isDeveloper: true
  };
}

function localLocation() {
  return { locationId: "downtown", location_id: "downtown", name: "Downtown" };
}

function localWorld() {
  // Block World only requires an object with a locations array to mount.
  // Location services are deliberately not simulated in Local Test.
  return {
    ok: true,
    current: localLocation(),
    locations: []
  };
}

function emptyService(service) {
  const common = { ok: true, localTest: true, service };

  switch (service) {
    case "status":
      return { ...common, status: { type: "active", until: null } };
    case "events":
      return { ...common, event: null, events: [] };
    case "travel":
      return { ...common, state: { current_region: "riftcity", traveling_to: null, arrives_at: null }, destinations: [] };
    case "education":
      return { ...common, enrollments: [], courses: [] };
    case "production":
      return { ...common, batches: [], facilities: [] };
    case "bank":
      return { ...common, account: { checking: 0, savings: 0 }, investments: [], tiers: [], ledger: [], security: { frozen: false }, risk: {} };
    case "law":
      return { ...common, law: { heat: 0, tier: { name: "Clear" }, history: [] } };
    case "activity":
      return { ...common, unread: 0, entries: [] };
    case "merits":
      return { ...common, state: { points: 0, upgrades: {} }, upgrades: [] };
    default:
      return { ...common, state: {}, items: [], rows: [] };
  }
}

function blockedMutation(path) {
  return json({
    ok: false,
    error: "LOCAL_FRONTEND_ONLY",
    message: `Local Test blocked authoritative request ${path}. Use Full Test for Worker/D1/R2 behavior.`
  }, 503);
}

async function mockApi(request, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  // Fake signed-in developer bootstrap. This is the key path that lets the
  // normal RiftCity shell leave the login screen without any real credentials.
  if (method === "GET" && path === "/api/auth/me") {
    return json({
      ok: true,
      authenticated: true,
      user: localUser(),
      player: localPlayer(),
      location: localLocation(),
      localTest: true
    });
  }

  if (method === "GET" && (path === "/api/player" || path === "/api/player/state")) {
    return json({ ok: true, player: localPlayer(), localTest: true });
  }

  if (method === "GET" && path === "/api/world") {
    return json(localWorld());
  }

  const blockResponse = await mockBlockApi(request, path);
  if (blockResponse) return blockResponse;

  if (method === "GET" && path.startsWith("/api/services/")) {
    const service = decodeURIComponent(path.slice("/api/services/".length).split("/")[0] || "");
    return json(emptyService(service));
  }

  // Approved dynamic asset bytes are server-owned. Do not pretend to validate
  // them locally; source-controlled /assets/* still comes from the preview cache.
  if (method === "GET" && path.startsWith("/api/assets/")) {
    return json({
      ok: false,
      error: "LOCAL_ASSET_SERVER_UNAVAILABLE",
      message: "Server-approved R2 assets require Full Test. Source-controlled public assets still work locally."
    }, 404);
  }

  // Logout/login/register and every POST/PUT/PATCH/DELETE remain blocked.
  if (method !== "GET") return blockedMutation(path);

  return json({
    ok: false,
    error: "LOCAL_FRONTEND_ONLY",
    message: `No Local Test mock exists for GET ${path}. Use Full Test if this screen requires backend data.`
  }, 503);
}


function freshSingleState() {
  const player = {
    ...localPlayer(),
    id: "single-player",
    userId: "single-player-user",
    username: "SinglePlayer"
  };
  return {
    schemaVersion: 1,
    player,
    world: {
      current: localLocation(),
      locations: []
    },
    app: {},
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function singleStateUrl() {
  return self.location.origin + SINGLE_PREFIX + "__single_state__/save.json";
}

function normalizeImportedSingleState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Single-player save must be one JSON object.");
  if (input.schemaVersion != null && Number(input.schemaVersion) !== 1) throw new Error("Unsupported single-player save schemaVersion.");
  const jsonText = JSON.stringify(input);
  if (jsonText.length > 2_000_000) throw new Error("Single-player save exceeds the 2 MB browser-sandbox limit.");
  const state = cloneJson(input);
  state.schemaVersion = 1;
  state.player = state.player && typeof state.player === "object" && !Array.isArray(state.player)
    ? { ...freshSingleState().player, ...state.player, id: "single-player", userId: "single-player-user", username: "SinglePlayer" }
    : freshSingleState().player;
  state.world = state.world && typeof state.world === "object" && !Array.isArray(state.world)
    ? state.world
    : freshSingleState().world;
  state.app = state.app && typeof state.app === "object" && !Array.isArray(state.app) ? state.app : {};
  state.createdAt = Number(state.createdAt || Date.now());
  state.updatedAt = Date.now();
  return state;
}

async function loadSingleState() {
  const cache = await caches.open(SINGLE_STATE_CACHE);
  const response = await cache.match(singleStateUrl());
  if (!response) {
    const state = freshSingleState();
    await saveSingleState(state);
    return state;
  }
  try {
    return normalizeImportedSingleState(await response.json());
  } catch (_) {
    const state = freshSingleState();
    await saveSingleState(state);
    return state;
  }
}

async function saveSingleState(input) {
  const state = normalizeImportedSingleState(input);
  const cache = await caches.open(SINGLE_STATE_CACHE);
  await cache.put(singleStateUrl(), new Response(JSON.stringify(state), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  }));
  return state;
}

function mergePlainObject(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = mergePlainObject(out[key], value);
    } else {
      out[key] = cloneJson(value);
    }
  }
  return out;
}

function singleUser() {
  return {
    id: "single-player-user",
    username: "SinglePlayer",
    role: "player",
    isAdmin: false,
    isDeveloper: false
  };
}

async function mockSingleApi(request, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (path === "/api/single-player/state" && method === "GET") {
    return json({ ok: true, state: await loadSingleState(), singlePlayer: true });
  }
  if (path === "/api/single-player/state" && (method === "PUT" || method === "PATCH")) {
    const body = await readJson(request);
    const current = await loadSingleState();
    const incoming = method === "PATCH" ? mergePlainObject(current, body?.patch || {}) : body?.state;
    if (!incoming) return json({ ok: false, error: "SINGLE_PLAYER_INVALID_STATE" }, 400);
    const state = await saveSingleState(incoming);
    return json({ ok: true, state, singlePlayer: true });
  }
  if (path === "/api/single-player/state/reset" && method === "POST") {
    await caches.delete(SINGLE_STATE_CACHE);
    return json({ ok: true, state: await loadSingleState(), singlePlayer: true });
  }

  const state = await loadSingleState();

  if (method === "GET" && path === "/api/auth/me") {
    return json({
      ok: true,
      authenticated: true,
      user: singleUser(),
      player: cloneJson(state.player),
      location: cloneJson(state.world?.current || localLocation()),
      singlePlayer: true
    });
  }

  if (method === "GET" && (path === "/api/player" || path === "/api/player/state")) {
    return json({ ok: true, player: cloneJson(state.player), singlePlayer: true });
  }

  if (method === "GET" && path === "/api/world") {
    return json({
      ok: true,
      current: cloneJson(state.world?.current || localLocation()),
      locations: cloneJson(state.world?.locations || []),
      singlePlayer: true
    });
  }

  // Static world source stays authoritative in Single Player. Returning no
  // browser-published block forces RiftCity to use its checked-in JSON/JS fallback.
  const publicBlock = path.match(/^\/api\/world\/blocks\/([^/]+)$/);
  if (method === "GET" && publicBlock) {
    const id = safeBlockId(publicBlock[1]);
    return json({
      ok: true,
      blockId: id,
      published: false,
      revision: 0,
      block: null,
      integrity: null,
      message: "Single Player uses the current source-controlled world fallback.",
      singlePlayer: true
    });
  }

  if (method === "GET" && path === "/api/services") {
    return json({ ok: true, services: [], singlePlayer: true });
  }

  if (method === "GET" && path.startsWith("/api/services/")) {
    const service = decodeURIComponent(path.slice("/api/services/".length).split("/")[0] || "");
    return json({ ...emptyService(service), singlePlayer: true, localTest: false });
  }

  if (method === "GET" && path === "/api/items") return json({ ok: true, items: [], singlePlayer: true });
  if (method === "GET" && path === "/api/inventory") return json({ ok: true, items: [], inventory: [], singlePlayer: true });
  if (method === "GET" && path === "/api/crimes") return json({ ok: true, crimes: [], history: [], singlePlayer: true });

  if (method === "GET" && path.startsWith("/api/assets/")) {
    return json({
      ok: false,
      error: "SINGLE_PLAYER_SERVER_ASSET_UNAVAILABLE",
      message: "R2-backed assets are unavailable in static Single Player. Source-controlled public assets still work."
    }, 404);
  }

  // Sign-in screens should never trap the static build, but Single Player does
  // not create accounts or credentials.
  if (method === "POST" && (path === "/api/auth/login" || path === "/api/auth/register")) {
    return json({
      ok: true,
      authenticated: true,
      user: singleUser(),
      player: cloneJson(state.player),
      singlePlayer: true
    });
  }

  return json({
    ok: false,
    error: "SINGLE_PLAYER_ROUTE_NOT_SIMULATED",
    message: `Static Single Player does not simulate ${method} ${path}. World rendering/editor JSON remain available; use Full Test for authoritative MMO systems.`
  }, 503);
}

async function previewMode(event) {
  if (!event.clientId) return "";
  const client = await self.clients.get(event.clientId);
  if (!client) return "";
  try {
    const pathname = new URL(client.url).pathname;
    if (pathname.startsWith(SINGLE_PREFIX)) return "single";
    if (pathname.startsWith(PREFIX)) return "local";
    return "";
  } catch (_) {
    return "";
  }
}

async function previewClient(event) {
  if (!event.clientId) return false;
  const client = await self.clients.get(event.clientId);
  if (!client) return false;
  try { return new URL(client.url).pathname.startsWith(PREFIX); }
  catch (_) { return false; }
}

async function cachedPreview(pathname, mode = "local") {
  const prefix = mode === "single" ? SINGLE_PREFIX : PREFIX;
  const cache = await caches.open(mode === "single" ? SINGLE_CACHE_NAME : CACHE_NAME);
  let rel = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname.replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) rel += "index.html";
  const url = self.location.origin + prefix + rel;
  let response = await cache.match(url);
  if (!response && !rel.includes(".")) response = await cache.match(self.location.origin + prefix + "index.html");
  return response;
}

self.addEventListener("fetch", event => {
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    const directSingle = url.origin === self.location.origin && url.pathname.startsWith(SINGLE_PREFIX);
    const directLocal = url.origin === self.location.origin && url.pathname.startsWith(PREFIX);
    let mode = directSingle ? "single" : directLocal ? "local" : await previewMode(event);
    const fromPreview = Boolean(mode);

    if (!fromPreview) return fetch(event.request);

    // External CDN requests required by the browser build remain normal network
    // requests. Only same-origin RiftCity preview traffic is sandboxed here.
    if (url.origin !== self.location.origin) return fetch(event.request);

    const activePrefix = mode === "single" ? SINGLE_PREFIX : PREFIX;
    const directPreview = mode === "single" ? directSingle : directLocal;

    if (mode === "local") {
      const prefixedEditor = PREFIX + "dev/block-editor";
      const rootEditor = url.pathname === "/dev/block-editor" || url.pathname === "/dev/block-editor/";

      if (event.request.mode === "navigate" && rootEditor && !directPreview) {
        return Response.redirect(self.location.origin + prefixedEditor, 302);
      }
      if (directPreview && (url.pathname === prefixedEditor || url.pathname === prefixedEditor + "/")) {
        return localBlockEditorPage();
      }
    }

    if (event.request.mode === "navigate" && !directPreview && url.pathname === "/") {
      return Response.redirect(self.location.origin + activePrefix + "index.html", 302);
    }

    if (url.pathname.startsWith("/api/")) {
      return mode === "single"
        ? await mockSingleApi(event.request, url)
        : await mockApi(event.request, url);
    }

    const cached = await cachedPreview(url.pathname, mode);
    if (cached) return cached;

    return new Response(`${mode === "single" ? "Single Player" : "Local Test"} asset not found: ${url.pathname}`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  })());
});
