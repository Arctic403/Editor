/* Ironvale Local Play native compiler worker.
   Uses the Apache-2.0 wasm-clang runtime by Ben Smith/WebAssembly Community Group.
   Compiler assets are fetched only in Local Play and cached by the browser.
   Source: https://github.com/binji/wasm-clang (pinned commit below).
*/
'use strict';

const WASM_CLANG_COMMIT = '648c4a89997a351eef75cdaec3ef5b89d4937dec';
const TOOLCHAIN_BASE = `https://raw.githubusercontent.com/binji/wasm-clang/${WASM_CLANG_COMMIT}/`;
const SHARED_RUNTIME = TOOLCHAIN_BASE + 'shared.js';
const CLANG_URL = TOOLCHAIN_BASE + 'clang';
const LLD_URL = TOOLCHAIN_BASE + 'lld';
const MEMFS_URL = TOOLCHAIN_BASE + 'memfs';
const TOOLCHAIN_CACHE = 'ironvale-browser-clang-v1';
const EMPTY_TAR_URL = 'data:application/octet-stream;base64,' + btoa('\0'.repeat(1024));
const moduleCache = new Map();

importScripts(SHARED_RUNTIME);

function report(message) {
  self.postMessage({ type: 'progress', message: String(message || '') });
}

async function cachedBytes(url) {
  if (url.startsWith('data:')) {
    const response = await fetch(url);
    return response.arrayBuffer();
  }
  const request = new Request(url, { mode: 'cors', cache: 'force-cache' });
  const cache = await caches.open(TOOLCHAIN_CACHE);
  let response = await cache.match(request);
  if (!response) {
    report(`Downloading native toolchain: ${url.split('/').pop()}…`);
    response = await fetch(request);
    if (!response.ok) throw new Error(`Native toolchain download failed (${response.status}) for ${url}`);
    await cache.put(request, response.clone());
  }
  return response.arrayBuffer();
}

async function compileModule(url) {
  if (moduleCache.has(url)) return moduleCache.get(url);
  const promise = cachedBytes(url).then(bytes => WebAssembly.compile(bytes));
  moduleCache.set(url, promise);
  try { return await promise; }
  catch (error) { moduleCache.delete(url); throw error; }
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
    clang: CLANG_URL,
    lld: LLD_URL,
    memfs: MEMFS_URL,
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

  const clang = await api.getModule(CLANG_URL);
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
  const lld = await api.getModule(LLD_URL);
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
