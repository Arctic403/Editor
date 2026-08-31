/* Ironvale Local Play native compiler worker.
   Uses the Apache-2.0 wasm-clang runtime by Ben Smith/WebAssembly Community Group.
   Compiler assets are fetched only in Local Play and cached by the browser.
   Source: https://github.com/binji/wasm-clang (pinned commit below).
*/
'use strict';

const WASM_CLANG_COMMIT = '648c4a89997a351eef75cdaec3ef5b89d4937dec';
const TOOLCHAIN_MIRRORS = Object.freeze([
  `https://cdn.jsdelivr.net/gh/binji/wasm-clang@${WASM_CLANG_COMMIT}/`,
  `https://raw.githubusercontent.com/binji/wasm-clang/${WASM_CLANG_COMMIT}/`
]);
const TOOLCHAIN_CACHE = 'ironvale-browser-clang-v2';
const TOOLCHAIN_CACHE_PREFIX = '__ironvale_browser_clang__';
const EMPTY_TAR_URL = 'data:application/octet-stream;base64,' + btoa('\0'.repeat(1024));
const moduleCache = new Map();
let sharedApiPromise = null;

function report(message) {
  self.postMessage({ type: 'progress', message: String(message || '') });
}

function cleanPath(value) {
  const parts = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function toolchainName(value) {
  const name = String(value || '').split('/').pop();
  if (!['clang', 'lld', 'memfs'].includes(name)) throw new Error(`Unsupported compiler asset: ${value}`);
  return name;
}

function cacheKey(name) {
  return `${self.location.origin}/${TOOLCHAIN_CACHE_PREFIX}/${WASM_CLANG_COMMIT}/${name}`;
}

async function fetchWithTimeout(url, responseType = 'arrayBuffer', timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return responseType === 'text' ? await response.text() : await response.arrayBuffer();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFromMirrors(name, responseType = 'arrayBuffer') {
  const failures = [];
  for (const base of TOOLCHAIN_MIRRORS) {
    const url = base + name;
    try {
      report(`Fetching compiler ${name} from ${new URL(base).hostname}…`);
      const value = await fetchWithTimeout(url, responseType);
      const size = responseType === 'text' ? value.length : value.byteLength;
      if (!size) throw new Error('empty response');
      return value;
    } catch (error) {
      failures.push(`${new URL(base).hostname}: ${error?.name || 'Error'} ${error?.message || error}`);
      report(`Compiler mirror failed (${new URL(base).hostname}); trying fallback…`);
    }
  }
  throw new Error(`Could not load compiler asset ${name}. ${failures.join(' | ')}`);
}

async function cachedBytes(value) {
  if (String(value).startsWith('data:')) {
    const response = await fetch(value);
    return response.arrayBuffer();
  }

  const name = toolchainName(value);
  const cache = await caches.open(TOOLCHAIN_CACHE);
  const key = cacheKey(name);
  const cached = await cache.match(key);
  if (cached) {
    const bytes = await cached.arrayBuffer();
    if (bytes.byteLength) return bytes;
    await cache.delete(key);
  }

  report(`Downloading native toolchain: ${name}…`);
  const bytes = await fetchFromMirrors(name, 'arrayBuffer');
  await cache.put(key, new Response(bytes.slice(0), {
    headers: {
      'Content-Type': 'application/wasm',
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  }));
  return bytes;
}

async function loadCompilerApi() {
  if (sharedApiPromise) return sharedApiPromise;
  sharedApiPromise = (async () => {
    report('Loading browser compiler runtime…');
    const source = await fetchFromMirrors('shared.js', 'text');
    let factory;
    try {
      factory = new Function(`${source}\n;return API;`);
    } catch (error) {
      throw new Error(`Compiler runtime could not be parsed: ${error?.message || error}`);
    }
    let api;
    try {
      api = factory();
    } catch (error) {
      throw new Error(`Compiler runtime could not start: ${error?.message || error}`);
    }
    if (typeof api !== 'function') throw new Error('Compiler runtime loaded without its API constructor.');
    return api;
  })();
  try {
    return await sharedApiPromise;
  } catch (error) {
    sharedApiPromise = null;
    throw error;
  }
}

async function compileModule(value) {
  const name = toolchainName(value);
  if (moduleCache.has(name)) return moduleCache.get(name);
  const promise = cachedBytes(name).then(bytes => WebAssembly.compile(bytes));
  moduleCache.set(name, promise);
  try { return await promise; }
  catch (error) { moduleCache.delete(name); throw error; }
}

function addDirectories(memfs, path, created) {
  const parts = cleanPath(path).split('/');
  parts.pop();
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (created.has(current)) continue;
    memfs.addDirectory(current);
    created.add(current);
  }
}

async function build(files) {
  const API = await loadCompilerApi();
  const diagnostics = [];
  const hostWrite = text => {
    const value = String(text || '');
    diagnostics.push(value);
    const trimmed = value.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (trimmed) report(trimmed.slice(0, 1200));
  };

  const api = new API({
    readBuffer: cachedBytes,
    compileStreaming: compileModule,
    hostWrite,
    clang: 'clang',
    lld: 'lld',
    memfs: 'memfs',
    sysroot: EMPTY_TAR_URL,
    showTiming: false
  });
  await api.ready;

  const normalized = (Array.isArray(files) ? files : [])
    .map(file => ({ path: cleanPath(file?.path), content: String(file?.content ?? '') }))
    .filter(file => file.path && file.path.startsWith('native/'));
  const sources = normalized.filter(file => /\.(?:cpp|cc|cxx)$/i.test(file.path));
  if (!sources.length) throw new Error('No C++ sources found under native/.');

  const createdDirs = new Set();
  for (const file of normalized) {
    addDirectories(api.memfs, file.path, createdDirs);
    api.memfs.addFile(file.path, file.content);
  }

  const clang = await api.getModule('clang');
  const objects = [];
  let index = 0;
  for (const source of sources) {
    const object = `__ironvale_obj_${index++}.o`;
    report(`C++ ${source.path}`);
    await api.run(
      clang,
      'clang', '-cc1',
      '-triple', 'wasm32-unknown-unknown',
      '-emit-obj', '-O3',
      '-fno-exceptions', '-fno-rtti',
      '-I', 'native/include',
      '-o', object,
      '-x', 'c++', source.path
    );
    objects.push(object);
  }

  report(`Linking RiftCore (${objects.length} object${objects.length === 1 ? '' : 's'})…`);
  const lld = await api.getModule('lld');
  const output = '__ironvale_rift_core.wasm';
  await api.run(
    lld,
    'wasm-ld', '--no-threads',
    '--no-entry', '--export-all', '--export-memory',
    '--initial-memory=33554432', '--max-memory=67108864',
    '--strip-all', ...objects, '-o', output
  );

  const result = Uint8Array.from(api.memfs.getFileContents(output));
  const module = await WebAssembly.compile(result);
  const exports = new Set(WebAssembly.Module.exports(module).map(item => item.name));
  if (!exports.has('memory') || !exports.has('rift_core_version')) {
    throw new Error('Local C++ build completed but RiftCore ABI exports are missing.');
  }
  report(`Native build ready: ${(result.byteLength / 1024).toFixed(1)} KB WASM.`);
  return { result, diagnostics: diagnostics.join('') };
}

self.onmessage = async event => {
  if (event.data?.type !== 'compile') return;
  try {
    const { result, diagnostics } = await build(event.data.files);
    self.postMessage({ type: 'done', buffer: result.buffer, diagnostics }, [result.buffer]);
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: String(error?.message || error),
      stack: String(error?.stack || '')
    });
  }
};
