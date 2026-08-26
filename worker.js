/* Mobile Workspace Cloudflare Worker
   - Serves the Editor's static assets.
   - Provides a narrowly-scoped RiftCity Live Test broker.
   - Cloudflare credentials are supplied by the user's browser per request and
     are never persisted by this Worker.
*/
const TARGET_REPO = "Arctic403/RiftCityV1";
const PREVIEW_WORKER = "riftcity-live-test";
const PREVIEW_D1 = "riftcity-live-test-db";
const PREVIEW_R2 = "riftcity-live-test-assets";
const MAX_FILES = 5000;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 1_500_000;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function safeError(error) {
  const message = error?.message || String(error || "Unknown error");
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 2000);
}

function normalizePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new Error(`Unsafe workspace path: ${raw}`);
  return parts.join("/");
}

function isSecretPath(path) {
  const base = String(path || "").split("/").pop() || "";
  return /^(?:\.env)(?:\..*)?$/i.test(base)
    || /^(?:\.npmrc|\.pypirc|id_rsa|id_ed25519)$/i.test(base)
    || /\.(?:pem|key|p12|pfx)$/i.test(base);
}

function validateCredentials(body) {
  const accountId = String(body?.accountId || "").trim();
  const apiToken = String(body?.apiToken || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("Cloudflare Account ID must be 32 hexadecimal characters.");
  if (!apiToken) throw new Error("Cloudflare API token is required.");
  return { accountId, apiToken };
}

async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error("Expected application/json.");
  return request.json();
}

function apiBase(accountId) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
}

async function cfRequest(accountId, token, path, init = {}, options = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${apiBase(accountId)}${path}`, { ...init, headers });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) {}

  if (options.allow404 && response.status === 404) return { response, payload, result: null };
  if (!response.ok || payload?.success === false) {
    const errors = Array.isArray(payload?.errors) ? payload.errors.map((item) => item?.message).filter(Boolean).join("; ") : "";
    throw new Error(errors || text || `Cloudflare API request failed (${response.status}).`);
  }
  return { response, payload, result: payload?.result ?? payload };
}

function parseQuoted(text) {
  const value = String(text || "").trim();
  const double = value.match(/^"([\s\S]*)"$/);
  if (double) return double[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const single = value.match(/^'([\s\S]*)'$/);
  if (single) return single[1];
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function findScalar(toml, key, fallback = "") {
  const match = String(toml || "").match(new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+?)\\s*$`, "m"));
  return match ? parseQuoted(match[1]) : fallback;
}

function tableSection(toml, name) {
  const re = new RegExp(`^\\s*\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`, "m");
  const match = re.exec(toml);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = toml.slice(start);
  const next = rest.search(/^\s*\[/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function arrayTables(toml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^\\s*\\[\\[${escaped}\\]\\]\\s*$`, "gm");
  const matches = [...toml.matchAll(regex)];
  return matches.map((match) => {
    const start = match.index + match[0].length;
    const rest = toml.slice(start);
    const nextHeader = rest.search(/^\s*\[/m);
    const body = nextHeader >= 0 ? rest.slice(0, nextHeader) : rest;
    const values = {};
    for (const line of body.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
      if (m) values[m[1]] = parseQuoted(m[2]);
    }
    return values;
  });
}

function parseStringArray(toml, key) {
  const match = String(toml || "").match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"));
  if (!match) return [];
  return match[1].split(",").map((item) => parseQuoted(item.trim())).filter((item) => typeof item === "string" && item);
}

function parseVars(toml) {
  const section = tableSection(toml, "vars");
  const vars = {};
  for (const line of section.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (match) vars[match[1]] = parseQuoted(match[2]);
  }
  return vars;
}

function parseProjectConfig(files) {
  const map = new Map(files.map((file) => [file.path, file]));
  const toml = map.get("wrangler.toml")?.content || "";
  const hasPublic = files.some((file) => file.path.startsWith("public/"));
  const assetsSection = tableSection(toml, "assets");
  const assetDirectory = String(findScalar(assetsSection, "directory", hasPublic ? "./public" : "."))
    .replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  const main = normalizePath(String(findScalar(toml, "main", map.has("src/index.js") ? "src/index.js" : "worker.js")).replace(/^\.\//, ""));
  const compatibilityDate = String(findScalar(toml, "compatibility_date", "2026-08-26"));
  const flags = parseStringArray(toml, "compatibility_flags");
  const d1Bindings = arrayTables(toml, "d1_databases").map((row) => String(row.binding || "")).filter(Boolean);
  const r2Bindings = arrayTables(toml, "r2_buckets").map((row) => String(row.binding || "")).filter(Boolean);
  const vars = parseVars(toml);
  if (!map.has(main)) throw new Error(`Worker main module not found in workspace: ${main}`);
  return { map, toml, main, assetDirectory, compatibilityDate, flags, d1Bindings, r2Bindings, vars };
}

function parentDir(path) {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function resolveImport(importer, specifier, map) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const parts = specifier.startsWith("/") ? [] : parentDir(importer).split("/").filter(Boolean);
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error(`Worker import escapes the workspace: ${specifier} from ${importer}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const base = parts.join("/");
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.json`, `${base}/index.js`, `${base}/index.mjs`];
  return candidates.find((path) => map.has(path)) || "";
}

function extractImports(source) {
  const specs = new Set();
  const text = String(source || "");
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) specs.add(match[1]);
  }
  return [...specs];
}

function collectWorkerModules(config) {
  const modules = [];
  const visited = new Set();
  const stack = [config.main];

  while (stack.length) {
    const path = stack.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const file = config.map.get(path);
    if (!file) throw new Error(`Worker module is missing: ${path}`);
    modules.push(file);

    if (/\.(?:js|mjs|cjs)$/i.test(path)) {
      for (const specifier of extractImports(file.content)) {
        if (specifier.startsWith("cloudflare:") || specifier.startsWith("node:")) continue;
        if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
          throw new Error(`Live Test cannot direct-deploy package import "${specifier}" from ${path}. Commit/build generated dependencies first or keep Worker imports local.`);
        }
        const resolved = resolveImport(path, specifier, config.map);
        if (!resolved) throw new Error(`Worker import not found: ${specifier} from ${path}`);
        stack.push(resolved);
      }
    }
  }
  return modules;
}

function staticAssetPath(path, dir) {
  if (dir === ".") return `/${path}`;
  const prefix = `${dir}/`;
  if (!path.startsWith(prefix)) return "";
  const relative = path.slice(prefix.length);
  return relative ? `/${relative}` : "";
}

function decodeWorkspaceContent(content) {
  const value = String(content ?? "");
  const match = value.match(/^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return { bytes: new TextEncoder().encode(value), mime: "" };
  const binary = atob(match[2].replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return { bytes, mime: match[1] || "application/octet-stream" };
}

function mimeFor(path, fallback = "") {
  if (fallback) return fallback;
  const ext = (path.split(".").pop() || "").toLowerCase();
  return ({
    html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    ico: "image/x-icon", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
    woff: "font/woff", woff2: "font/woff2", wasm: "application/wasm", xml: "application/xml"
  })[ext] || "application/octet-stream";
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
  }
  return btoa(binary);
}

async function ensureD1(accountId, token) {
  const listed = await cfRequest(accountId, token, `/d1/database?name=${encodeURIComponent(PREVIEW_D1)}&per_page=50`);
  const rows = Array.isArray(listed.result) ? listed.result : [];
  let database = rows.find((row) => row?.name === PREVIEW_D1);
  if (!database) {
    database = (await cfRequest(accountId, token, "/d1/database", {
      method: "POST",
      body: JSON.stringify({ name: PREVIEW_D1 })
    })).result;
  }
  const id = database?.uuid || database?.id;
  if (!id) throw new Error("Cloudflare created/found the preview D1 database but did not return its ID.");
  return { id, name: PREVIEW_D1 };
}

async function ensureR2(accountId, token) {
  const existing = await cfRequest(accountId, token, `/r2/buckets/${encodeURIComponent(PREVIEW_R2)}`, {}, { allow404: true });
  if (!existing.result) {
    await cfRequest(accountId, token, "/r2/buckets", {
      method: "POST",
      body: JSON.stringify({ name: PREVIEW_R2, storageClass: "Standard" })
    });
  }
  return { name: PREVIEW_R2 };
}

async function applySchema(accountId, token, databaseId, files) {
  const schema = files.find((file) => file.path === "schema.sql")?.content;
  if (!schema) return false;
  const bytes = new TextEncoder().encode(schema).byteLength;
  if (bytes > MAX_SCHEMA_BYTES) throw new Error("schema.sql is too large for automatic Live Test migration.");
  await cfRequest(accountId, token, `/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: schema })
  });
  return true;
}

async function uploadAssets(accountId, token, config, files) {
  const candidates = [];
  for (const file of files) {
    const urlPath = staticAssetPath(file.path, config.assetDirectory);
    if (!urlPath || isSecretPath(file.path)) continue;
    const decoded = decodeWorkspaceContent(file.content);
    if (decoded.bytes.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`${file.path} is ${(decoded.bytes.byteLength / 1024 / 1024).toFixed(1)} MiB; Cloudflare static assets are limited to 25 MiB each.`);
    }
    const fullHash = await sha256Hex(decoded.bytes);
    candidates.push({
      path: urlPath,
      hash: fullHash.slice(0, 32),
      bytes: decoded.bytes,
      mime: mimeFor(file.path, decoded.mime)
    });
  }

  if (!candidates.length) return { jwt: null, count: 0 };

  const manifest = {};
  const byHash = new Map();
  for (const asset of candidates) {
    manifest[asset.path] = { hash: asset.hash, size: asset.bytes.byteLength };
    if (!byHash.has(asset.hash)) byHash.set(asset.hash, asset);
  }

  const session = await cfRequest(accountId, token, `/workers/scripts/${PREVIEW_WORKER}/assets-upload-session`, {
    method: "POST",
    body: JSON.stringify({ manifest })
  });
  let completion = session.result?.jwt || "";
  const buckets = Array.isArray(session.result?.buckets) ? session.result.buckets : [];

  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const asset = byHash.get(hash);
      if (!asset) throw new Error(`Cloudflare requested an unknown asset hash: ${hash}`);
      form.append(hash, new Blob([bytesToBase64(asset.bytes)], { type: asset.mime }), asset.path.replace(/^\//, "") || "asset");
    }
    const uploaded = await cfRequest(accountId, completion, "/workers/assets/upload?base64=true", {
      method: "POST",
      body: form
    });
    if (uploaded.result?.jwt) completion = uploaded.result.jwt;
  }

  if (!completion) throw new Error("Cloudflare asset upload did not return a completion token.");
  return { jwt: completion, count: candidates.length };
}

function moduleMime(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (ext === "wasm") return "application/wasm";
  if (ext === "json") return "application/json";
  return "application/javascript+module";
}

async function deployWorker(accountId, token, config, modules, assetUpload, d1, r2) {
  const bindings = [];
  if (assetUpload.jwt) bindings.push({ type: "assets", name: "ASSETS" });
  if (d1) {
    for (const name of config.d1Bindings) bindings.push({ type: "d1", name, id: d1.id });
  }
  if (r2) {
    for (const name of config.r2Bindings) bindings.push({ type: "r2_bucket", name, bucket_name: r2.name });
  }
  for (const [name, value] of Object.entries(config.vars)) {
    bindings.push({ type: "plain_text", name, text: String(value) });
  }

  const metadata = {
    main_module: config.main,
    compatibility_date: config.compatibilityDate,
    bindings
  };
  if (config.flags.length) metadata.compatibility_flags = config.flags;
  if (assetUpload.jwt) metadata.assets = { jwt: assetUpload.jwt };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  for (const module of modules) {
    const decoded = decodeWorkspaceContent(module.content);
    form.append(module.path, new Blob([decoded.bytes], { type: moduleMime(module.path) }), module.path);
  }

  await cfRequest(accountId, token, `/workers/scripts/${PREVIEW_WORKER}`, { method: "PUT", body: form });
  await cfRequest(accountId, token, `/workers/scripts/${PREVIEW_WORKER}/subdomain`, {
    method: "POST",
    body: JSON.stringify({ enabled: true, previews_enabled: true })
  });
}

async function accountSubdomain(accountId, token) {
  const response = await cfRequest(accountId, token, "/workers/subdomain");
  const subdomain = response.result?.subdomain;
  if (!subdomain) throw new Error("Your Cloudflare account does not have a workers.dev subdomain configured.");
  return subdomain;
}

function sanitizeFiles(input) {
  if (!Array.isArray(input) || !input.length) throw new Error("Live Test workspace is empty.");
  if (input.length > MAX_FILES) throw new Error(`Live Test supports up to ${MAX_FILES} files.`);
  const files = [];
  const seen = new Set();
  for (const item of input) {
    const path = normalizePath(item?.path);
    if (path.startsWith(".git/") || path.startsWith("node_modules/") || isSecretPath(path)) continue;
    if (seen.has(path)) throw new Error(`Duplicate workspace path: ${path}`);
    seen.add(path);
    files.push({ path, content: typeof item?.content === "string" ? item.content : String(item?.content ?? "") });
  }
  return files;
}

async function deployLiveTest(body) {
  const { accountId, apiToken } = validateCredentials(body);
  if (body?.repo !== TARGET_REPO) throw new Error(`Live Test is restricted to ${TARGET_REPO}.`);
  const files = sanitizeFiles(body.files);
  const config = parseProjectConfig(files);
  const modules = collectWorkerModules(config);

  let d1 = null;
  let r2 = null;
  if (config.d1Bindings.length) {
    d1 = await ensureD1(accountId, apiToken);
    await applySchema(accountId, apiToken, d1.id, files);
  }
  if (config.r2Bindings.length) r2 = await ensureR2(accountId, apiToken);

  const assets = await uploadAssets(accountId, apiToken, config, files);
  await deployWorker(accountId, apiToken, config, modules, assets, d1, r2);
  const subdomain = await accountSubdomain(accountId, apiToken);
  const url = `https://${PREVIEW_WORKER}.${subdomain}.workers.dev/`;

  return {
    ok: true,
    url,
    worker: PREVIEW_WORKER,
    d1: d1?.name || null,
    r2: r2?.name || null,
    modules: modules.length,
    assets: assets.count,
    githubTouched: false
  };
}

async function statusLiveTest(body) {
  const { accountId, apiToken } = validateCredentials(body);
  const subdomain = await accountSubdomain(accountId, apiToken);
  const worker = await cfRequest(accountId, apiToken, `/workers/scripts/${PREVIEW_WORKER}/subdomain`, {}, { allow404: true });
  const d1List = await cfRequest(accountId, apiToken, `/d1/database?name=${encodeURIComponent(PREVIEW_D1)}&per_page=10`);
  const d1 = (Array.isArray(d1List.result) ? d1List.result : []).find((row) => row?.name === PREVIEW_D1);

  let r2 = null;
  try {
    const bucket = await cfRequest(accountId, apiToken, `/r2/buckets/${encodeURIComponent(PREVIEW_R2)}`, {}, { allow404: true });
    if (bucket.result) r2 = PREVIEW_R2;
  } catch (_) {}

  const workerExists = !!worker.result;
  return {
    ok: true,
    workerExists,
    d1: d1 ? PREVIEW_D1 : null,
    r2,
    url: workerExists && worker.result?.enabled ? `https://${PREVIEW_WORKER}.${subdomain}.workers.dev/` : null
  };
}

async function stopLiveTest(body) {
  const { accountId, apiToken } = validateCredentials(body);
  const current = await cfRequest(accountId, apiToken, `/workers/scripts/${PREVIEW_WORKER}/subdomain`, {}, { allow404: true });
  if (!current.result) return { ok: true, removed: false };
  await cfRequest(accountId, apiToken, `/workers/scripts/${PREVIEW_WORKER}`, { method: "DELETE" });
  return { ok: true, removed: true };
}

async function handleApi(request, env, url) {
  if (request.method !== "POST") return json({ ok: false, error: "POST required." }, 405);
  try {
    const body = await readJson(request);
    if (url.pathname === "/api/live-test/deploy") return json(await deployLiveTest(body));
    if (url.pathname === "/api/live-test/status") return json(await statusLiveTest(body));
    if (url.pathname === "/api/live-test/stop") return json(await stopLiveTest(body));
    return json({ ok: false, error: "Not found." }, 404);
  } catch (error) {
    console.error("Live Test API error:", safeError(error));
    return json({ ok: false, error: safeError(error) }, 400);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/live-test/")) return handleApi(request, env, url);
    if (!env.ASSETS) return new Response("Editor static assets binding is missing.", { status: 500 });
    return env.ASSETS.fetch(request);
  }
};
