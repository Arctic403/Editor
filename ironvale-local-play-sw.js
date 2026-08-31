/* Ironvale Local Play service worker
   Narrow-scope sandbox for the Editor's local play mode.
   Serves cached Ironvale public/ assets and emulates only the current Ironvale core API.
*/
const CACHE_NAME = 'ironvale-local-play-preview-v1';
const STATE_CACHE = 'ironvale-local-play-state-v1';
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const PREFIX = SCOPE_PATH.endsWith('/') ? SCOPE_PATH : SCOPE_PATH + '/';
const WORLD_MIN_X = 0;
const WORLD_MAX_X = 640;
const WORLD_MIN_Z = 0;
const WORLD_MAX_Z = 640;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Ironvale-Local-Play': '1'
    }
  });
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function now() { return Date.now(); }

function freshState() {
  const timestamp = now();
  return {
    schemaVersion: 1,
    user: {
      id: 'ironvale-local-user',
      username: 'LocalTester',
      role: 'developer',
      createdAt: timestamp,
      lastActiveAt: timestamp
    },
    character: {
      userId: 'ironvale-local-user',
      displayName: 'LocalTester',
      position: { x: 320, y: 0.9, z: 320, yaw: 0 },
      createdAt: timestamp,
      updatedAt: timestamp
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function stateUrl() {
  return self.location.origin + PREFIX + '__state__/core.json';
}

function normalizeState(input) {
  const base = freshState();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return base;
  const state = clone(input);
  state.schemaVersion = 1;
  state.user = state.user && typeof state.user === 'object' && !Array.isArray(state.user)
    ? { ...base.user, ...state.user, id: base.user.id, role: 'developer' }
    : base.user;
  state.character = state.character && typeof state.character === 'object' && !Array.isArray(state.character)
    ? { ...base.character, ...state.character, userId: base.user.id }
    : base.character;
  state.character.position = state.character.position && typeof state.character.position === 'object' && !Array.isArray(state.character.position)
    ? { ...base.character.position, ...state.character.position }
    : base.character.position;
  state.createdAt = Number(state.createdAt || base.createdAt);
  state.updatedAt = now();
  return state;
}

async function loadState() {
  const cache = await caches.open(STATE_CACHE);
  const response = await cache.match(stateUrl());
  if (!response) {
    const state = freshState();
    await saveState(state);
    return state;
  }
  try { return normalizeState(await response.json()); }
  catch (_) {
    const state = freshState();
    await saveState(state);
    return state;
  }
}

async function saveState(input) {
  const state = normalizeState(input);
  const cache = await caches.open(STATE_CACHE);
  await cache.put(stateUrl(), new Response(JSON.stringify(state), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  }));
  return state;
}

async function readJson(request) {
  try { return await request.clone().json(); }
  catch (_) { return {}; }
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bootstrapPayload(state) {
  return {
    ok: true,
    authenticated: true,
    user: clone(state.user),
    character: clone(state.character),
    world: {
      id: 'ironvale-terrain',
      url: '/world/ironvale-terrain.json',
      foundation: 'rift-terrain-v1',
      size: [640, 640],
      negativeWorldY: true
    },
    localPlay: true
  };
}

async function mockApi(request, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname;
  let state = await loadState();

  if (method === 'GET' && path === '/api/bootstrap') return json(bootstrapPayload(state));
  if (method === 'GET' && path === '/api/auth/me') {
    return json({ ok: true, authenticated: true, user: clone(state.user), localPlay: true });
  }
  if (method === 'POST' && (path === '/api/auth/login' || path === '/api/auth/register')) {
    const body = await readJson(request);
    const username = String(body?.username || '').trim();
    if (username) {
      state.user.username = username.slice(0, 24);
      state.character.displayName = state.character.displayName === 'LocalTester' ? state.user.username : state.character.displayName;
      state.user.lastActiveAt = now();
      state.updatedAt = now();
      state = await saveState(state);
    }
    return json({ ok: true, authenticated: true, user: clone(state.user), localPlay: true });
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    return json({ ok: true, localPlay: true });
  }

  if (method === 'GET' && path === '/api/character') {
    return json({ ok: true, character: clone(state.character), localPlay: true });
  }
  if (method === 'PATCH' && path === '/api/character') {
    const body = await readJson(request);
    const displayName = String(body?.displayName || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 '\-]{1,23}$/.test(displayName)) {
      return json({ ok: false, error: 'Character name must be 2-24 characters.' }, 400);
    }
    state.character.displayName = displayName;
    state.character.updatedAt = now();
    state.updatedAt = now();
    state = await saveState(state);
    return json({ ok: true, character: clone(state.character), localPlay: true });
  }
  if (method === 'PUT' && path === '/api/character/position') {
    const body = await readJson(request);
    const x = finite(body?.x), y = finite(body?.y), z = finite(body?.z), yaw = finite(body?.yaw);
    if ([x, y, z, yaw].some(value => value === null)) return json({ ok: false, error: 'Invalid position' }, 400);
    if (x < WORLD_MIN_X || x > WORLD_MAX_X || z < WORLD_MIN_Z || z > WORLD_MAX_Z) {
      return json({ ok: false, error: 'Position outside active terrain bounds' }, 400);
    }
    state.character.position = { x, y, z, yaw };
    state.character.updatedAt = now();
    state.user.lastActiveAt = now();
    state.updatedAt = now();
    state = await saveState(state);
    return json({ ok: true, savedAt: state.updatedAt, localPlay: true });
  }

  if (method === 'GET' && path === '/api/health') {
    return json({ ok: true, service: 'ironvale-local-play', database: 'browser-cache', localPlay: true });
  }

  if (method === 'GET' && path === '/api/local-play/state') {
    return json({ ok: true, state: clone(state), localPlay: true });
  }
  if (method === 'POST' && path === '/api/local-play/reset') {
    await caches.delete(STATE_CACHE);
    state = await loadState();
    return json({ ok: true, state, localPlay: true });
  }

  return json({
    ok: false,
    error: 'IRONVALE_LOCAL_ROUTE_NOT_SIMULATED',
    message: `Ironvale Local Play does not simulate ${method} ${path}.`,
    localPlay: true
  }, 404);
}

async function cachedAsset(pathname) {
  let rel = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname.replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const cache = await caches.open(CACHE_NAME);
  let response = await cache.match(self.location.origin + PREFIX + rel);
  if (!response && !rel.includes('.')) response = await cache.match(self.location.origin + PREFIX + 'index.html');
  return response;
}

self.addEventListener('message', event => {
  const type = event.data?.type;
  const port = event.ports?.[0];
  if (type === 'IRONVALE_LOCAL_RESET_STATE') {
    event.waitUntil((async () => {
      await caches.delete(STATE_CACHE);
      const state = await loadState();
      try { port?.postMessage({ ok: true, state }); } catch (_) {}
    })());
    return;
  }
  if (type === 'IRONVALE_LOCAL_EXPORT_STATE') {
    event.waitUntil((async () => {
      const state = await loadState();
      try { port?.postMessage({ ok: true, state }); } catch (_) {}
    })());
    return;
  }
  if (type === 'IRONVALE_LOCAL_IMPORT_STATE') {
    event.waitUntil((async () => {
      try {
        const state = await saveState(event.data?.payload);
        port?.postMessage({ ok: true, state });
      } catch (error) {
        try { port?.postMessage({ ok: false, error: String(error?.message || error) }); } catch (_) {}
      }
    })());
  }
});

self.addEventListener('fetch', event => {
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    const client = event.clientId ? await self.clients.get(event.clientId) : null;
    const controlledPreview = client ? new URL(client.url).pathname.startsWith(PREFIX) : false;
    const directPreview = url.origin === self.location.origin && url.pathname.startsWith(PREFIX);
    if (!controlledPreview && !directPreview) return fetch(event.request);
    if (url.origin !== self.location.origin) return fetch(event.request);

    if (url.pathname.startsWith('/api/')) return mockApi(event.request, url);

    if (event.request.mode === 'navigate' && !directPreview && url.pathname === '/') {
      return Response.redirect(self.location.origin + PREFIX + 'index.html', 302);
    }

    const cached = await cachedAsset(url.pathname);
    if (cached) return cached;

    return new Response(`Ironvale Local Play asset not found: ${url.pathname}`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  })());
});