/* RiftCity browser Local Test service worker.
   Passes the Editor through untouched and serves only preview clients from Cache Storage.

   Local Test is intentionally NOT a backend emulator:
   - it provides only the minimum safe GET/bootstrap responses required to enter RiftCity;
   - authoritative mutations stay blocked;
   - production Worker, D1 and R2 are never contacted by preview API requests.
*/
const CACHE_NAME = "riftcity-local-preview-v1";
const PREFIX = "/__riftcity_local__/";

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
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

function mockApi(request, url) {
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

  // Return "no published server layout" so Block World deliberately falls back
  // to the CURRENT LOCAL public/block1.js that we actually want to test.
  if (method === "GET" && /^\/api\/world\/blocks\/[^/]+$/.test(path)) {
    return json({
      ok: false,
      error: "LOCAL_LAYOUT_FALLBACK",
      message: "No server-published block is used in Local Test; using local block source."
    }, 404);
  }

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

async function previewClient(event) {
  if (!event.clientId) return false;
  const client = await self.clients.get(event.clientId);
  if (!client) return false;
  try { return new URL(client.url).pathname.startsWith(PREFIX); }
  catch (_) { return false; }
}

async function cachedPreview(pathname) {
  const cache = await caches.open(CACHE_NAME);
  let rel = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname.replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) rel += "index.html";
  const url = self.location.origin + PREFIX + rel;
  let response = await cache.match(url);
  if (!response && !rel.includes(".")) response = await cache.match(self.location.origin + PREFIX + "index.html");
  return response;
}

self.addEventListener("fetch", event => {
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    const directPreview = url.origin === self.location.origin && url.pathname.startsWith(PREFIX);
    const fromPreview = directPreview || await previewClient(event);

    if (!fromPreview) return fetch(event.request);

    // External CDN requests required by the browser build remain normal network
    // requests. Only same-origin RiftCity preview traffic is sandboxed here.
    if (url.origin !== self.location.origin) return fetch(event.request);

    if (url.pathname.startsWith("/api/")) {
      return mockApi(event.request, url);
    }

    const cached = await cachedPreview(url.pathname);
    if (cached) return cached;

    return new Response("Local Test asset not found: " + url.pathname, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  })());
});
