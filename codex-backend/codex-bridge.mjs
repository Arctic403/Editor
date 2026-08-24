import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { Codex } from "@openai/codex-sdk";

const PORT = Number(process.env.PORT || 8788);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const BRIDGE_TOKEN = process.env.CODEX_BRIDGE_TOKEN || "";
const EDITOR_ORIGIN = process.env.EDITOR_ORIGIN || "*";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 600;
const MAX_FILE_BYTES = 1_500_000;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
  process.exit(1);
}

const codex = new Codex({ apiKey: OPENAI_API_KEY });

function corsHeaders(req) {
  const incoming = req.headers.origin || "";
  const allowOrigin = EDITOR_ORIGIN === "*"
    ? "*"
    : (incoming === EDITOR_ORIGIN ? EDITOR_ORIGIN : "null");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
    "Access-Control-Allow-Headers": "Content-Type,X-Codex-Bridge-Token",
    "Vary": "Origin",
  };
}

function sendJson(req, res, status, payload) {
  res.writeHead(status, {
    ...corsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function safeRelativePath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Invalid file path.");
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some(part => part === "." || part === "..")) {
    throw new Error(`Unsafe file path: ${input}`);
  }
  return parts.join("/");
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeWorkspace(root, files) {
  if (!Array.isArray(files) || !files.length) throw new Error("No workspace files supplied.");
  if (files.length > MAX_FILES) throw new Error(`Too many files. Max is ${MAX_FILES}.`);

  for (const file of files) {
    const rel = safeRelativePath(file?.name);
    const content = typeof file?.content === "string" ? file.content : "";
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error(`File too large for Codex bridge: ${rel}`);
    }
    const absolute = path.join(root, rel);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
}

async function scanWorkspace(root) {
  const out = new Map();

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if ([".git", "node_modules", ".codex"].includes(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(abs, "utf8").catch(() => null);
        if (content === null || content.includes("\u0000")) continue;
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        out.set(rel, content);
      }
    }
  }

  await walk(root);
  return out;
}

function diffMaps(before, after) {
  const changes = [];
  for (const [filePath, content] of after) {
    if (!before.has(filePath)) {
      changes.push({ path: filePath, status: "created", content });
    } else if (before.get(filePath) !== content) {
      changes.push({ path: filePath, status: "modified", content });
    }
  }
  for (const filePath of before.keys()) {
    if (!after.has(filePath)) changes.push({ path: filePath, status: "deleted" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function authorized(req) {
  if (!BRIDGE_TOKEN) return true;
  const provided = req.headers["x-codex-bridge-token"] || "";
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(BRIDGE_TOKEN));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(req, res, 200, { ok: true, service: "riftcity-codex-bridge" });
    return;
  }

  if (req.method !== "POST" || req.url !== "/api/codex/run") {
    sendJson(req, res, 404, { error: "Not found." });
    return;
  }

  if (!authorized(req)) {
    sendJson(req, res, 401, { error: "Invalid Codex bridge token." });
    return;
  }

  let tempRoot = "";
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    const prompt = String(body.prompt || "").trim();
    if (!prompt) throw new Error("Prompt is required.");

    const readOnly = Boolean(body.readOnly);
    const allowedEfforts = new Set(["minimal", "low", "medium", "high", "xhigh"]);
    const reasoningEffort = allowedEfforts.has(body.reasoningEffort) ? body.reasoningEffort : "high";

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "riftcity-codex-"));
    await writeWorkspace(tempRoot, body.files);
    const before = await scanWorkspace(tempRoot);

    const thread = codex.startThread({
      workingDirectory: tempRoot,
      skipGitRepoCheck: true,
      sandboxMode: readOnly ? "read-only" : "workspace-write",
      modelReasoningEffort: reasoningEffort,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });

    const fullPrompt = readOnly
      ? `${prompt}\n\nDo not edit any files. Return your explanation only.`
      : `${prompt}\n\nYou are operating inside a temporary copy of the user's workspace. Make the requested edits directly in the workspace files. Preserve unrelated behavior. Do not access the network. At the end, briefly summarize what you changed.`;

    const turn = await thread.run(fullPrompt);
    const after = await scanWorkspace(tempRoot);
    const changes = readOnly ? [] : diffMaps(before, after);

    sendJson(req, res, 200, {
      ok: true,
      threadId: thread.id || null,
      finalResponse: turn.finalResponse || "",
      changes,
    });
  } catch (error) {
    console.error(error);
    sendJson(req, res, 500, { error: error?.message || "Codex run failed." });
  } finally {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`RiftCity Codex bridge listening on port ${PORT}`);
  console.log(`CORS origin: ${EDITOR_ORIGIN}`);
  console.log(`Bridge token required: ${BRIDGE_TOKEN ? "yes" : "NO (set CODEX_BRIDGE_TOKEN before exposing publicly)"}`);
});
