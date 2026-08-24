import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { Codex } from "@openai/codex-sdk";
import { CodexAppServerClient } from "./app-server-client.js";

const PORT = clampInt(process.env.PORT, 1, 65535, 8788);
const HOST = process.env.HOST || "0.0.0.0";
const BRIDGE_TOKEN = String(process.env.EDITOR_BRIDGE_TOKEN || "");
const EDITOR_ORIGIN = String(process.env.EDITOR_ORIGIN || "*");
const MAX_BODY_BYTES = 6_000_000;
const MAX_FILES = 160;
const MAX_FILE_CHARS = 600_000;
const MAX_TOTAL_CHARS = 3_000_000;
const MAX_CHANGES = 80;
const RUN_TIMEOUT_MS = clampInt(process.env.CODEX_RUN_TIMEOUT_MS, 60_000, 20 * 60_000, 10 * 60_000);
const RATE_LIMIT = clampInt(process.env.CODEX_RATE_LIMIT, 1, 60, 6);
const RATE_WINDOW_MS = 60_000;

const appServer = new CodexAppServerClient({ cwd: process.cwd() });
const rateBuckets = new Map();
let runBusy = false;

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return sendEmpty(res, 204, cors);

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/health" && req.method === "GET") {
      let account = null;
      let codexReady = true;
      let authError = null;
      try { account = await appServer.account(); }
      catch (error) { codexReady = false; authError = error.message; }
      return sendJson(res, 200, {
        ok: true,
        service: "riftcity-codex-host",
        provider: "codex",
        codexReady,
        signedIn: Boolean(account),
        account: account ? publicAccount(account) : null,
        authError,
      }, cors);
    }

    if (!authorized(req)) return sendJson(res, 401, { error: "Unauthorized bridge request." }, cors);

    if (url.pathname === "/account" && req.method === "GET") {
      const account = await appServer.account();
      return sendJson(res, 200, { ok: true, signedIn: Boolean(account), account: account ? publicAccount(account) : null }, cors);
    }

    if (url.pathname === "/auth/device/start" && req.method === "POST") {
      const login = await appServer.startDeviceLogin();
      return sendJson(res, 200, {
        ok: true,
        type: login?.type || "chatgptDeviceCode",
        loginId: login?.loginId || null,
        verificationUrl: login?.verificationUrl || null,
        userCode: login?.userCode || null,
      }, cors);
    }

    if (url.pathname === "/api/codex/run" && req.method === "POST") {
      if (!allowRate(req)) return sendJson(res, 429, { error: `Too many Codex requests. Limit is ${RATE_LIMIT} per minute.` }, cors);
      if (runBusy) return sendJson(res, 429, { error: "A Codex task is already running on this bridge." }, cors);
      runBusy = true;
      try {
        const body = await readJsonBody(req);
        const task = validateTask(body);
        const account = await appServer.account();
        if (!account) return sendJson(res, 401, { error: "Codex is not signed in. Use Sign in with ChatGPT first." }, cors);
        const result = await runCodexTask(task);
        return sendJson(res, 200, result, cors);
      } finally {
        runBusy = false;
      }
    }

    return sendJson(res, 404, { error: "Not found." }, cors);
  } catch (error) {
    console.error(error);
    return sendJson(res, 400, { error: error?.message || "Bridge request failed." }, cors);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RiftCity Codex host listening on http://${HOST}:${PORT}`);
  console.log(BRIDGE_TOKEN ? "Bridge token protection enabled." : "WARNING: EDITOR_BRIDGE_TOKEN is not set.");
});

process.on("SIGTERM", () => { appServer.stop(); server.close(() => process.exit(0)); });
process.on("SIGINT", () => { appServer.stop(); server.close(() => process.exit(0)); });

async function runCodexTask(task) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "riftcity-codex-"));
  try {
    const before = new Map();
    for (const file of task.files) {
      const target = safeJoin(workspace, file.name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
      before.set(file.name, file.content);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Codex task timed out.")), RUN_TIMEOUT_MS);
    let turn;
    try {
      const codex = new Codex();
      const thread = codex.startThread({
        ...(task.model ? { model: task.model } : {}),
        workingDirectory: workspace,
        skipGitRepoCheck: true,
        sandboxMode: task.readOnly ? "read-only" : "workspace-write",
        approvalPolicy: "never",
        modelReasoningEffort: normalizeEffort(task.reasoningEffort),
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      });
      turn = await thread.run(buildPrompt(task), { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    const after = await readWorkspace(workspace);
    const changes = task.readOnly ? [] : diffWorkspace(before, after);
    return {
      ok: true,
      provider: "codex",
      model: task.model || null,
      summary: String(turn?.finalResponse || "Codex task complete."),
      notes: [
        `Codex worked in an isolated workspace with network access disabled.`,
        `${changes.length} changed file(s) returned for review; nothing is pushed automatically.`
      ],
      changes,
      usage: turn?.usage || null,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function buildPrompt(task) {
  const active = task.activeFile || "none";
  const selection = task.selection ? `\n\nCurrent editor selection from ${active}:\n${task.selection}` : "";
  const history = task.conversation.length
    ? `\n\nRecent editor conversation:\n${task.conversation.map(x => `${x.role.toUpperCase()}: ${x.content}`).join("\n")}`
    : "";
  return [
    "You are working in an isolated copy of a mobile browser IDE workspace.",
    task.readOnly
      ? "READ ONLY: inspect and explain only. Do not modify or create files."
      : "EDIT MODE: make the requested changes directly in the workspace files. Keep unrelated behavior intact.",
    "Do not access the network. Do not include or create secrets, API keys, passwords, tokens, or credentials.",
    "Prefer complete, coherent fixes. You may inspect any files present in this temporary workspace and run local checks when useful.",
    `Active file: ${active}`,
    `Task:\n${task.prompt}`,
    selection,
    history,
  ].filter(Boolean).join("\n\n");
}

function validateTask(body) {
  const prompt = String(body?.prompt || "").trim();
  if (!prompt) throw new Error("Prompt is required.");
  if (prompt.length > 40_000) throw new Error("Prompt is too long.");
  if (!Array.isArray(body?.files) || !body.files.length) throw new Error("At least one workspace file is required.");
  if (body.files.length > MAX_FILES) throw new Error(`Too many files. Maximum is ${MAX_FILES}.`);
  let total = 0;
  const files = body.files.map(file => {
    const name = safePath(file?.name);
    const content = String(file?.content ?? "");
    if (content.length > MAX_FILE_CHARS) throw new Error(`File is too large: ${name}`);
    total += content.length;
    return { name, content };
  });
  if (total > MAX_TOTAL_CHARS) throw new Error("Workspace context is too large.");
  const conversation = Array.isArray(body?.conversation) ? body.conversation.slice(-16).map(item => ({
    role: item?.role === "assistant" ? "assistant" : "user",
    content: String(item?.content || "").slice(0, 4000),
  })).filter(x => x.content) : [];
  return {
    prompt,
    files,
    activeFile: body?.activeFile ? safePath(body.activeFile) : "",
    selection: String(body?.selection || "").slice(0, 25_000),
    readOnly: Boolean(body?.readOnly),
    reasoningEffort: String(body?.reasoningEffort || "high"),
    model: sanitizeModel(body?.model),
    conversation,
  };
}

async function readWorkspace(root) {
  const result = new Map();
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", ".codex", ".wrangler", "dist", "build"].includes(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(full);
      if (info.size > 1_000_000) continue;
      const buffer = await readFile(full);
      if (buffer.includes(0)) continue;
      result.set(rel.replace(/\\/g, "/"), buffer.toString("utf8"));
    }
  }
  await walk(root);
  return result;
}

function diffWorkspace(before, after) {
  const changes = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const filePath of [...paths].sort()) {
    if (changes.length >= MAX_CHANGES) break;
    const had = before.has(filePath);
    const has = after.has(filePath);
    const oldText = before.get(filePath) ?? "";
    const newText = after.get(filePath) ?? "";
    if (had && !has) changes.push({ path: filePath, status: "deleted", content: "", reason: "Codex deleted this file." });
    else if (!had && has) changes.push({ path: filePath, status: "created", content: newText, reason: "Codex created this file." });
    else if (oldText !== newText) changes.push({ path: filePath, status: "modified", content: newText, reason: "Codex modified this file." });
  }
  return changes;
}

async function readJsonBody(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_BODY_BYTES) throw new Error("Request is too large.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text || "{}"); }
  catch (_) { throw new Error("Request body must be valid JSON."); }
}

function safePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some(part => part === "." || part === "..")) throw new Error(`Unsafe file path: ${value}`);
  return parts.join("/");
}

function safeJoin(root, relative) {
  const clean = safePath(relative);
  const target = path.resolve(root, clean);
  const base = path.resolve(root) + path.sep;
  if (!target.startsWith(base)) throw new Error(`Unsafe file path: ${relative}`);
  return target;
}

function sanitizeModel(value) {
  const model = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,100}$/.test(model) ? model : "";
}

function normalizeEffort(value) {
  return new Set(["minimal", "low", "medium", "high", "xhigh"]).has(value) ? value : "high";
}

function authorized(req) {
  if (!BRIDGE_TOKEN) return true;
  const got = String(req.headers["x-editor-bridge-token"] || "");
  const gotHash = crypto.createHash("sha256").update(got).digest();
  const expectedHash = crypto.createHash("sha256").update(BRIDGE_TOKEN).digest();
  return crypto.timingSafeEqual(gotHash, expectedHash);
}

function allowRate(req) {
  const identity = String(req.headers["x-editor-bridge-token"] || req.socket.remoteAddress || "anonymous");
  const key = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  const now = Date.now();
  const bucket = rateBuckets.get(key) || [];
  const fresh = bucket.filter(ts => now - ts < RATE_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT) { rateBuckets.set(key, fresh); return false; }
  fresh.push(now);
  rateBuckets.set(key, fresh);
  return true;
}

function publicAccount(account) {
  return {
    type: account?.type || "chatgpt",
    email: account?.email || null,
    planType: account?.planType || null,
  };
}

function corsHeaders(req) {
  const incoming = String(req.headers.origin || "");
  const allow = EDITOR_ORIGIN === "*" ? "*" : (incoming === EDITOR_ORIGIN ? incoming : EDITOR_ORIGIN);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept,X-Editor-Bridge-Token",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function sendEmpty(res, status, headers = {}) { res.writeHead(status, headers); res.end(); }
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
