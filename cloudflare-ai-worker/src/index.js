const OPENAI_URL = "https://api.openai.com/v1/responses";
const MAX_FILES = 120;
const MAX_FILE_CHARS = 500000;
const MAX_TOTAL_CHARS = 2200000;
const MAX_PROMPT_CHARS = 30000;
const MAX_SELECTION_CHARS = 25000;
const ALLOWED_EFFORT = new Set(["low", "medium", "high"]);
const ALLOWED_STATUS = new Set(["created", "modified", "deleted"]);

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          status: { type: "string", enum: ["created", "modified", "deleted"] },
          content: { type: "string" },
          reason: { type: "string" },
        },
        required: ["path", "status", "content", "reason"],
      },
    },
  },
  required: ["summary", "notes", "changes"],
};

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      // Keep health public so the browser can verify connectivity without
      // triggering a token-header CORS preflight. The actual AI route
      // remains protected by AI_APP_TOKEN.
      return json({ ok: true, service: "riftcity-workspace-ai", model: env.OPENAI_MODEL || "gpt-5.1" }, 200, cors);
    }

    // Keep API routing explicit so unknown /api/* paths return JSON 404s, while
    // every normal browser request falls through to the editor's static assets.
    if (url.pathname !== "/api/ai/run") {
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404, cors);
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "Not found." }, 404, cors);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, cors);
    if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401, cors);
    if (!env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY secret is not configured on this Worker." }, 500, cors);

    try {
      const body = await readJsonBody(request);
      const task = validateRequest(body);
      const model = sanitizeModel(task.model) || env.OPENAI_MODEL || "gpt-5.1";
      const effort = ALLOWED_EFFORT.has(task.reasoningEffort) ? task.reasoningEffort : "high";
      const input = buildInput(task);

      const openaiResponse = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          store: false,
          reasoning: { effort },
          input,
          text: {
            verbosity: "medium",
            format: {
              type: "json_schema",
              name: "workspace_edit_plan",
              description: "A safe code-edit plan with complete replacement contents for each changed file.",
              strict: true,
              schema: OUTPUT_SCHEMA,
            },
          },
          max_output_tokens: clampInt(env.MAX_OUTPUT_TOKENS, 4000, 30000, 18000),
        }),
      });

      const raw = await openaiResponse.json().catch(() => ({}));
      if (!openaiResponse.ok) {
        const message = raw?.error?.message || raw?.message || `OpenAI returned ${openaiResponse.status}.`;
        return json({ error: message }, openaiResponse.status >= 500 ? 502 : openaiResponse.status, cors);
      }

      const outputText = extractOutputText(raw);
      if (!outputText) throw new Error("The model returned no structured output.");
      let parsed;
      try { parsed = JSON.parse(outputText); }
      catch (_) { throw new Error("The model response could not be parsed as structured edits."); }

      const result = sanitizeResult(parsed, task);
      return json({
        ok: true,
        model: raw.model || model,
        responseId: raw.id || null,
        summary: result.summary,
        notes: result.notes,
        changes: result.changes,
        usage: raw.usage || null,
      }, 200, cors);
    } catch (error) {
      return json({ error: error?.message || "AI request failed." }, 400, cors);
    }
  },
};

function corsHeaders() {
  // The editor may be served from Workers, Pages, GitHub Pages, Safari previews,
  // or a local/file origin. Do not reject a valid bridge request just because
  // the browser Origin does not exactly match an optional environment value.
  // Authentication is handled separately by AI_APP_TOKEN.
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Editor-AI-Token,Accept",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

function authorized(request, env) {
  const expected = String(env.AI_APP_TOKEN || "");
  if (!expected) return true;
  return request.headers.get("X-Editor-AI-Token") === expected;
}

async function readJsonBody(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 5_500_000) throw new Error("Request is too large.");
  const text = await request.text();
  if (text.length > 5_500_000) throw new Error("Request is too large.");
  try { return JSON.parse(text || "{}"); }
  catch (_) { throw new Error("Request body must be valid JSON."); }
}

function validateRequest(body) {
  const prompt = String(body?.prompt || "").trim();
  if (!prompt) throw new Error("Prompt is required.");
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error("Prompt is too long.");
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
  if (total > MAX_TOTAL_CHARS) throw new Error("Workspace context is too large. Use Smart or Active context mode.");

  const conversation = Array.isArray(body.conversation) ? body.conversation.slice(-16).map(item => ({
    role: item?.role === "assistant" ? "assistant" : "user",
    content: String(item?.content || "").slice(0, 4000),
  })).filter(x => x.content) : [];

  return {
    prompt,
    files,
    activeFile: body.activeFile ? safePath(body.activeFile) : "",
    selection: String(body.selection || "").slice(0, MAX_SELECTION_CHARS),
    readOnly: Boolean(body.readOnly),
    reasoningEffort: String(body.reasoningEffort || "high"),
    model: String(body.model || ""),
    conversation,
  };
}

function safePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some(part => part === "." || part === "..")) throw new Error(`Unsafe file path: ${value}`);
  return parts.join("/");
}

function sanitizeModel(value) {
  const model = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,100}$/.test(model) ? model : "";
}

function buildInput(task) {
  const developer = `You are a coding assistant embedded in a mobile browser IDE. You cannot execute commands or access files beyond the workspace text supplied in this request.\n\nRules:\n- Solve the user's coding task using only the supplied project context.\n- Preserve unrelated behavior and existing GitHub workflow.\n- Prefer small, coherent, production-quality edits.\n- Never fabricate files you do not need.\n- For every modified or created file, return the COMPLETE final file content in changes[].content, not a partial patch.\n- For deleted files, use status=deleted and content=\"\".\n- Paths must be relative workspace paths with no ../ segments.\n- If the request is explanation-only/read-only, return an empty changes array.\n- Never include secrets, API keys, passwords, access tokens, or credentials in generated source.\n- If context is insufficient for a safe edit, explain that in summary/notes rather than guessing destructively.`;

  const fileText = task.files.map(file => `\n===== FILE: ${file.name} =====\n${file.content}\n===== END FILE =====`).join("\n");
  const history = task.conversation.length
    ? `\nRecent conversation summaries:\n${task.conversation.map(x => `${x.role.toUpperCase()}: ${x.content}`).join("\n")}`
    : "";
  const selection = task.selection ? `\nCurrent editor selection:\n${task.selection}` : "";
  const mode = task.readOnly ? "READ ONLY: do not propose file changes." : "EDIT MODE: propose file changes when needed.";
  const user = `${mode}\nActive file: ${task.activeFile || "none"}\n\nTask:\n${task.prompt}${selection}${history}\n\nWorkspace context:${fileText}`;

  return [
    { role: "developer", content: [{ type: "input_text", text: developer }] },
    { role: "user", content: [{ type: "input_text", text: user }] },
  ];
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text) return response.output_text;
  for (const item of response?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

function sanitizeResult(parsed, task) {
  const supplied = new Set(task.files.map(f => f.name));
  const changes = [];
  for (const change of Array.isArray(parsed?.changes) ? parsed.changes.slice(0, 40) : []) {
    let path;
    try { path = safePath(change?.path); } catch (_) { continue; }
    const status = ALLOWED_STATUS.has(change?.status) ? change.status : "modified";
    if ((status === "modified" || status === "deleted") && !supplied.has(path)) {
      // Never overwrite or delete a file the model was not actually shown.
      continue;
    }
    changes.push({
      path,
      status,
      content: status === "deleted" ? "" : String(change?.content ?? ""),
      reason: String(change?.reason || "").slice(0, 500),
    });
  }
  return {
    summary: String(parsed?.summary || "Task complete.").slice(0, 8000),
    notes: (Array.isArray(parsed?.notes) ? parsed.notes : []).slice(0, 12).map(x => String(x).slice(0, 1500)),
    changes: task.readOnly ? [] : changes,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
