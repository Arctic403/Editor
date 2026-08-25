import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(process.cwd());
const BODY = String(process.env.AI_PATCH_BODY || '');
const EXPECTED_BRANCH = String(process.env.AI_PATCH_BRANCH || 'main');
const MAX_CHANGES = 40;
const MAX_BODY_CHARS = 65_000;
const MAX_FILE_BYTES = 1_500_000;
const MAX_TOTAL_BYTES = 6_000_000;

const PROTECTED_PREFIXES = [
  '.git/',
  '.github/workflows/',
  '.github/actions/',
  'scripts/ai-bridge/',
  'node_modules/',
];
const PROTECTED_EXACT = new Set([
  '.git',
  '.env',
  '.npmrc',
  '.assetsignore',
]);

function fail(message) {
  console.error(`AI patch rejected: ${message}`);
  process.exit(2);
}

function extractJson(body) {
  if (!body.trim()) fail('issue body is empty');
  if (body.length > MAX_BODY_CHARS) fail('issue body exceeds the bridge limit');
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : body).trim();
  try { return JSON.parse(raw); }
  catch (error) { fail(`payload is not valid JSON (${error.message})`); }
}

function safeRelativePath(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw) fail('change path is empty');
  if (raw.includes('\0')) fail(`path contains a NUL byte: ${raw}`);
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) fail(`unsafe path: ${raw}`);
  const normalized = parts.join('/');
  const lower = normalized.toLowerCase();
  if (PROTECTED_EXACT.has(lower) || PROTECTED_PREFIXES.some((p) => lower.startsWith(p))) {
    fail(`protected path cannot be changed through the bridge: ${normalized}`);
  }
  if (/(^|\/)(?:\.env(?:\.|$)|id_rsa|id_ed25519)(?:\/|$)/i.test(normalized)) fail(`secret-like path is blocked: ${normalized}`);
  if (/\.(?:pem|key|p12|pfx)$/i.test(normalized)) fail(`credential-like file is blocked: ${normalized}`);
  const absolute = path.resolve(ROOT, normalized);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + path.sep)) fail(`path escapes repository: ${normalized}`);
  return { relative: normalized, absolute };
}

async function assertNoSymlinkTraversal(relative) {
  const parts = relative.split('/');
  let current = ROOT;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = path.join(current, parts[i]);
    try {
      const info = await fsp.lstat(current);
      if (info.isSymbolicLink()) fail(`symlink traversal is blocked: ${relative}`);
      if (!info.isDirectory()) fail(`parent path is not a directory: ${relative}`);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function decodeContent(change) {
  const has = ['content', 'content_base64', 'content_gzip_base64'].filter((key) => change[key] != null);
  if (has.length !== 1) fail('write change must include exactly one content field');
  let buffer;
  if (has[0] === 'content') buffer = Buffer.from(String(change.content), 'utf8');
  else if (has[0] === 'content_base64') buffer = Buffer.from(String(change.content_base64), 'base64');
  else {
    try { buffer = zlib.gunzipSync(Buffer.from(String(change.content_gzip_base64), 'base64')); }
    catch (error) { fail(`invalid gzip/base64 content (${error.message})`); }
  }
  if (buffer.length > MAX_FILE_BYTES) fail(`one file exceeds ${MAX_FILE_BYTES} bytes`);
  if (buffer.includes(0)) fail('binary/NUL-containing files are not accepted by the issue bridge');
  return buffer;
}

function sanitizeCommitMessage(value) {
  const line = String(value || 'Apply AI patch').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (line || 'Apply AI patch').slice(0, 120);
}

async function appendOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  await fsp.appendFile(output, `${name}=${String(value).replace(/[\r\n]+/g, ' ')}\n`, 'utf8');
}

const payload = extractJson(BODY);
if (payload?.version !== 1) fail('version must be 1');
if (payload?.branch && payload.branch !== EXPECTED_BRANCH) fail(`branch must be ${EXPECTED_BRANCH}`);
if (!Array.isArray(payload?.changes) || !payload.changes.length) fail('changes must be a non-empty array');
if (payload.changes.length > MAX_CHANGES) fail(`too many changes; maximum is ${MAX_CHANGES}`);

let totalBytes = 0;
const seen = new Set();
const prepared = [];
for (const rawChange of payload.changes) {
  const action = rawChange?.action === 'delete' ? 'delete' : (rawChange?.action === 'write' ? 'write' : '');
  if (!action) fail('action must be write or delete');
  const target = safeRelativePath(rawChange?.path);
  if (seen.has(target.relative)) fail(`duplicate path: ${target.relative}`);
  seen.add(target.relative);
  await assertNoSymlinkTraversal(target.relative);
  const content = action === 'write' ? decodeContent(rawChange) : null;
  if (content) {
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail(`decoded patch exceeds ${MAX_TOTAL_BYTES} bytes`);
  }
  prepared.push({ action, ...target, content });
}

for (const change of prepared) {
  if (change.action === 'delete') {
    try {
      const info = await fsp.lstat(change.absolute);
      if (info.isSymbolicLink()) fail(`refusing to delete symlink through bridge: ${change.relative}`);
      await fsp.rm(change.absolute, { recursive: info.isDirectory(), force: true });
      console.log(`deleted ${change.relative}`);
    } catch (error) {
      if (error?.code === 'ENOENT') console.log(`already absent ${change.relative}`);
      else throw error;
    }
  } else {
    await fsp.mkdir(path.dirname(change.absolute), { recursive: true });
    await fsp.writeFile(change.absolute, change.content);
    console.log(`wrote ${change.relative} (${change.content.length} bytes)`);
  }
}

const commitMessage = sanitizeCommitMessage(payload.commit_message);
await appendOutput('commit_message', commitMessage);
await appendOutput('change_count', prepared.length);
console.log(`Prepared ${prepared.length} change(s).`);
