/* RiftCity browser Local Test service worker.
   Passes the Editor through untouched and serves only preview clients from Cache Storage.
*/
const CACHE_NAME = "riftcity-local-preview-v1";
const PREFIX = "/__riftcity_local__/";

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
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

    if (url.origin !== self.location.origin) return fetch(event.request);

    if (url.pathname.startsWith("/api/")) {
      return json({
        ok: false,
        error: "LOCAL_FRONTEND_ONLY",
        message: "RiftCity Local Test blocks Worker/D1/R2 API calls. Use Full Test for backend behavior."
      }, 503);
    }

    const cached = await cachedPreview(url.pathname);
    if (cached) return cached;

    return new Response("Local Test asset not found: " + url.pathname, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  })());
});
