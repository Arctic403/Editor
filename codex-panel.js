/* RiftCity Mobile Workspace - Cloudflare AI coding panel
   Browser-only client. Loads AFTER app-safari-v11.js + ide-v11.js.
   The OpenAI API key never belongs in this file; requests go through the Cloudflare Worker.
*/
(() => {
  "use strict";

  const STORAGE = {
    workerUrl: "riftcity_ai_worker_url",
    appToken: "riftcity_ai_app_token",
    history: "riftcity_ai_task_history_v2",
    conversation: "riftcity_ai_conversation_v2",
    model: "riftcity_ai_model_v2",
    endpoint: "riftcity_ai_endpoint_v1",
    healthEndpoint: "riftcity_ai_health_endpoint_v1",
  };

  const LIMITS = {
    maxFiles: 120,
    maxFileChars: 450000,
    maxContextChars: 1850000,
    maxHistory: 20,
    maxConversationTurns: 8,
    maxUndo: 10,
  };

  const state = {
    busy: false,
    pendingChanges: [],
    undoStack: [],
    history: readJson(STORAGE.history, []),
    conversation: readJson(STORAGE.conversation, []),
    lastContextFiles: [],
  };

  const $ = (id) => document.getElementById(id);
  const esc = (value = "") => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      return parsed ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function normalizeUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function injectStyles() {
    if ($("codexPanelStyles")) return;
    const style = document.createElement("style");
    style.id = "codexPanelStyles";
    style.textContent = `
      .codex-launch-btn{position:fixed;right:14px;bottom:14px;z-index:9997;border:1px solid #4b5563;background:#111827;color:#fff;border-radius:999px;padding:11px 15px;font-weight:800;box-shadow:0 12px 30px rgba(0,0,0,.35);cursor:pointer;-webkit-tap-highlight-color:transparent}
      .codex-panel{position:fixed;top:0;right:0;width:min(520px,100vw);height:100dvh;z-index:9999;background:#0b1020;color:#f8fafc;border-left:1px solid #263244;box-shadow:-18px 0 50px rgba(0,0,0,.45);display:flex;flex-direction:column;transform:translateX(102%);transition:transform .18s ease;overscroll-behavior:contain}
      .codex-panel.open{transform:translateX(0)}
      .codex-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #263244;background:#0f172a;min-height:48px}.codex-head strong{flex:1;font-size:15px}.codex-head button{border:1px solid #334155;background:#111827;color:#fff;border-radius:8px;padding:8px 10px;cursor:pointer;min-height:36px}
      .codex-body{flex:1;min-height:0;overflow:auto;padding:12px 12px calc(24px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:10px;-webkit-overflow-scrolling:touch}
      .codex-card{border:1px solid #263244;background:#111827;border-radius:12px;padding:10px;min-width:0}.codex-card.compact{padding:8px 10px}
      .codex-label{display:block;font-size:11px;color:#94a3b8;margin:0 0 5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
      .codex-input,.codex-select,.codex-textarea{width:100%;box-sizing:border-box;border:1px solid #334155;background:#090f1d;color:#fff;border-radius:9px;padding:9px;font:inherit;font-size:16px}.codex-textarea{min-height:132px;resize:vertical;line-height:1.42}
      .codex-row{display:flex;gap:8px;align-items:flex-end}.codex-row>*{flex:1;min-width:0}.codex-row.tight{align-items:center}
      .codex-actions{display:flex;gap:8px;flex-wrap:wrap}.codex-btn{border:1px solid #3b4a61;background:#182235;color:#fff;border-radius:9px;padding:9px 11px;font-weight:800;cursor:pointer;min-height:40px}.codex-btn.primary{background:#2563eb;border-color:#3b82f6}.codex-btn.good{background:#166534;border-color:#22c55e}.codex-btn.warn{background:#713f12;border-color:#f59e0b}.codex-btn.danger{background:#5f1820;border-color:#ef4444}.codex-btn:disabled{opacity:.48;cursor:not-allowed}
      .codex-status{font-size:12px;color:#cbd5e1;white-space:pre-wrap;line-height:1.45}.codex-muted{font-size:11px;color:#94a3b8;line-height:1.4}.codex-result{white-space:pre-wrap;font-size:13px;line-height:1.5;color:#e2e8f0;overflow-wrap:anywhere}
      .codex-badge{display:inline-block;padding:2px 6px;border-radius:99px;background:#1e293b;color:#cbd5e1;font-size:10px;margin-left:5px;vertical-align:middle}.codex-badge.ok{background:#14532d;color:#dcfce7}.codex-badge.warn{background:#78350f;color:#fef3c7}
      .codex-change{border:1px solid #334155;border-radius:10px;padding:9px;margin-top:8px;background:#0b1220;min-width:0}.codex-change b{display:block;overflow-wrap:anywhere}.codex-change small{color:#94a3b8;display:block;margin-top:3px}.codex-change-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.codex-change-actions .codex-btn{font-size:12px;padding:7px 9px;min-height:34px}
      .codex-diff{margin-top:8px;border:1px solid #273449;border-radius:8px;background:#070c16;max-height:320px;overflow:auto;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;overscroll-behavior:contain}.codex-diff-line{display:block;padding:1px 7px;min-width:max-content}.codex-diff-add{background:rgba(34,197,94,.14);color:#bbf7d0}.codex-diff-del{background:rgba(239,68,68,.14);color:#fecaca}.codex-diff-same{color:#94a3b8}
      .codex-history-item{border-top:1px solid #263244;padding:8px 0}.codex-history-item:first-child{border-top:0;padding-top:0}.codex-history-item button{width:100%;text-align:left;border:0;background:transparent;color:#e2e8f0;padding:0;cursor:pointer}.codex-history-item small{display:block;color:#94a3b8;margin-top:3px}
      .codex-progress{height:4px;border-radius:99px;background:#1e293b;overflow:hidden;margin-top:7px}.codex-progress>i{display:block;height:100%;width:30%;background:#3b82f6;animation:codex-slide 1.1s infinite ease-in-out;border-radius:99px}@keyframes codex-slide{0%{transform:translateX(-110%)}100%{transform:translateX(440%)}}
      .codex-hidden{display:none!important}
      @media(max-width:700px){.codex-panel{width:100vw;border-left:0}.codex-launch-btn{right:10px;bottom:calc(10px + env(safe-area-inset-bottom))}.codex-row{flex-direction:column;align-items:stretch}.codex-row.tight{flex-direction:row;align-items:center}.codex-body{padding:10px 10px calc(18px + env(safe-area-inset-bottom))}.codex-btn{min-height:44px}.codex-head button{min-height:40px}}
      @media(prefers-reduced-motion:reduce){.codex-panel{transition:none}.codex-progress>i{animation:none;width:100%}}
    `;
    document.head.appendChild(style);
  }

  function injectUi() {
    if ($("codexPanel")) return;

    const launch = document.createElement("button");
    launch.id = "codexLaunchBtn";
    launch.className = "codex-launch-btn";
    launch.type = "button";
    launch.textContent = "✦ AI";
    launch.addEventListener("click", () => $("codexPanel").classList.add("open"));
    document.body.appendChild(launch);

    const panel = document.createElement("aside");
    panel.id = "codexPanel";
    panel.className = "codex-panel";
    panel.setAttribute("aria-label", "AI coding assistant");
    panel.innerHTML = `
      <div class="codex-head">
        <strong>✦ Workspace AI</strong>
        <button id="codexHistoryBtn" type="button">History</button>
        <button id="codexSettingsBtn" type="button">Settings</button>
        <button id="codexCloseBtn" type="button" aria-label="Close AI panel">✕</button>
      </div>
      <div class="codex-body">
        <div class="codex-card" id="codexSettingsCard" hidden>
          <label class="codex-label" for="codexWorkerUrl">Cloudflare Worker URL</label>
          <input class="codex-input" id="codexWorkerUrl" placeholder="https://your-worker.your-subdomain.workers.dev" autocapitalize="off" autocomplete="off">
          <div style="height:8px"></div>
          <label class="codex-label" for="codexEndpoint">AI endpoint</label>
          <input class="codex-input" id="codexEndpoint" placeholder="/api/ai/run or full https://... URL" autocapitalize="off" autocomplete="off">
          <div style="height:8px"></div>
          <label class="codex-label" for="codexHealthEndpoint">Health endpoint</label>
          <input class="codex-input" id="codexHealthEndpoint" placeholder="/health or full https://... URL" autocapitalize="off" autocomplete="off">
          <div style="height:8px"></div>
          <label class="codex-label" for="codexAppToken">Private app token (optional but recommended)</label>
          <input class="codex-input" id="codexAppToken" type="password" placeholder="Matches AI_APP_TOKEN secret" autocomplete="off">
          <div style="height:8px"></div>
          <label class="codex-label" for="codexModel">Model override (optional)</label>
          <input class="codex-input" id="codexModel" placeholder="Leave blank to use Worker default" autocapitalize="off" autocomplete="off">
          <div style="height:8px"></div>
          <div class="codex-actions">
            <button class="codex-btn primary" id="codexSaveSettings" type="button">Save</button>
            <button class="codex-btn" id="codexTestWorker" type="button">Test Worker</button>
          </div>
          <div class="codex-muted" style="margin-top:8px">Your OpenAI API key stays in Cloudflare as a secret and is never stored in this editor.</div>
        </div>

        <div class="codex-card" id="codexHistoryCard" hidden>
          <div class="codex-row tight"><span class="codex-label" style="margin:0;flex:1">Recent tasks</span><button class="codex-btn" id="codexClearHistory" type="button">Clear</button></div>
          <div id="codexHistoryList" style="margin-top:8px"></div>
        </div>

        <div class="codex-card">
          <div class="codex-row">
            <div>
              <label class="codex-label" for="codexContext">Context</label>
              <select class="codex-select" id="codexContext">
                <option value="smart" selected>Smart workspace</option>
                <option value="active">Active file + manifests</option>
                <option value="workspace">Whole text workspace</option>
              </select>
            </div>
            <div>
              <label class="codex-label" for="codexEffort">Reasoning</label>
              <select class="codex-select" id="codexEffort">
                <option value="low">Low / cheaper</option>
                <option value="medium">Medium</option>
                <option value="high" selected>High</option>
              </select>
            </div>
          </div>
          <div style="height:9px"></div>
          <label class="codex-label" for="codexPrompt">Task</label>
          <textarea class="codex-textarea" id="codexPrompt" placeholder="Example: Find why Safari cannot close editor tabs. Fix it without changing the GitHub sync flow."></textarea>
          <div style="height:9px"></div>
          <div class="codex-actions">
            <button class="codex-btn primary" id="codexRunBtn" type="button">Run task</button>
            <button class="codex-btn" id="codexExplainBtn" type="button">Explain file</button>
            <button class="codex-btn" id="codexFixBtn" type="button">Fix selection/file</button>
            <button class="codex-btn" id="codexReviewBtn" type="button">Review workspace</button>
          </div>
        </div>

        <div class="codex-card compact">
          <span class="codex-label">Status</span>
          <div class="codex-status" id="codexStatus" aria-live="polite">Ready.</div>
          <div class="codex-progress codex-hidden" id="codexProgress"><i></i></div>
        </div>

        <div class="codex-card" id="codexResultCard" hidden>
          <span class="codex-label">AI response</span>
          <div class="codex-result" id="codexResult"></div>
          <div class="codex-muted" id="codexUsage" style="margin-top:8px"></div>
        </div>

        <div class="codex-card" id="codexChangesCard" hidden>
          <div class="codex-row tight"><span class="codex-label" style="margin:0;flex:1">Proposed workspace changes</span><span class="codex-badge" id="codexChangeCount">0</span></div>
          <div id="codexChanges"></div>
          <div style="height:9px"></div>
          <div class="codex-actions">
            <button class="codex-btn good" id="codexApplyAllBtn" type="button">Apply all</button>
            <button class="codex-btn warn" id="codexUndoBtn" type="button" disabled>Undo last AI apply</button>
            <button class="codex-btn danger" id="codexDiscardBtn" type="button">Discard</button>
          </div>
          <div class="codex-muted" style="margin-top:8px">Applying changes only updates the local editor workspace. Your existing GitHub Push button remains a separate action.</div>
        </div>
      </div>`;
    document.body.appendChild(panel);

    $("codexWorkerUrl").value = localStorage.getItem(STORAGE.workerUrl) || "";
    $("codexEndpoint").value = localStorage.getItem(STORAGE.endpoint) || "/api/ai/run";
    $("codexHealthEndpoint").value = localStorage.getItem(STORAGE.healthEndpoint) || "/health";
    $("codexAppToken").value = localStorage.getItem(STORAGE.appToken) || "";
    $("codexModel").value = localStorage.getItem(STORAGE.model) || "";

    $("codexCloseBtn").onclick = () => panel.classList.remove("open");
    $("codexSettingsBtn").onclick = () => toggleCard("codexSettingsCard");
    $("codexHistoryBtn").onclick = () => { toggleCard("codexHistoryCard"); renderHistory(); };
    $("codexSaveSettings").onclick = saveSettings;
    $("codexTestWorker").onclick = testWorker;
    $("codexRunBtn").onclick = () => runAi();
    $("codexExplainBtn").onclick = () => runAi("Explain the active file. Focus on architecture, dependencies, important behavior, and likely bugs. Do not modify files.", true);
    $("codexFixBtn").onclick = () => runAi(buildFixPrompt());
    $("codexReviewBtn").onclick = () => runAi("Review the workspace for bugs, broken mobile/Safari behavior, fragile code, and security problems. Make safe fixes where clearly appropriate and preserve existing behavior.");
    $("codexApplyAllBtn").onclick = applyAllChanges;
    $("codexUndoBtn").onclick = undoLastApply;
    $("codexDiscardBtn").onclick = clearChanges;
    $("codexClearHistory").onclick = clearHistory;
    renderHistory();
  }

  function toggleCard(id) {
    const card = $(id);
    if (card) card.hidden = !card.hidden;
  }

  function saveSettings() {
    const url = normalizeUrl($("codexWorkerUrl").value);
    const endpoint = $("codexEndpoint").value.trim() || "/api/ai/run";
    const healthEndpoint = $("codexHealthEndpoint").value.trim() || "/health";
    const token = $("codexAppToken").value.trim();
    const model = $("codexModel").value.trim();
    localStorage.setItem(STORAGE.workerUrl, url);
    localStorage.setItem(STORAGE.endpoint, endpoint);
    localStorage.setItem(STORAGE.healthEndpoint, healthEndpoint);
    localStorage.setItem(STORAGE.appToken, token);
    localStorage.setItem(STORAGE.model, model);
    setStatus("Settings saved.");
  }

  function getSettings() {
    return {
      workerUrl: normalizeUrl(localStorage.getItem(STORAGE.workerUrl) || $("codexWorkerUrl")?.value || ""),
      endpoint: (localStorage.getItem(STORAGE.endpoint) || $("codexEndpoint")?.value || "/api/ai/run").trim(),
      healthEndpoint: (localStorage.getItem(STORAGE.healthEndpoint) || $("codexHealthEndpoint")?.value || "/health").trim(),
      appToken: localStorage.getItem(STORAGE.appToken) || $("codexAppToken")?.value || "",
      model: localStorage.getItem(STORAGE.model) || $("codexModel")?.value || "",
    };
  }


  function resolveEndpoint(workerUrl, endpoint, fallback) {
    const value = String(endpoint || fallback || "").trim();
    if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
    if (!workerUrl) return "";
    const path = value.startsWith("/") ? value : `/${value}`;
    return `${workerUrl}${path}`;
  }

  async function testWorker() {
    const { workerUrl, healthEndpoint, appToken } = getSettings();
    if (!workerUrl) return setStatus("Add your Worker URL first.");
    try {
      setBusy(true);
      setStatus("Testing Worker…");
      const healthUrl = resolveEndpoint(workerUrl, healthEndpoint, "/health");
      const response = await fetch(healthUrl, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        headers: { "Accept": "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Worker returned ${response.status}`);
      setStatus(`Worker online${data.model ? ` • ${data.model}` : ""}.`);
    } catch (error) {
      setStatus(`Worker test failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function buildFixPrompt() {
    const editor = $("editor");
    const path = editor?.dataset?.filename || "";
    const selected = editor && editor.selectionStart !== editor.selectionEnd
      ? editor.value.slice(editor.selectionStart, editor.selectionEnd)
      : "";
    if (selected) {
      return `Fix the selected code in ${path || "the active file"}. Preserve surrounding behavior and make the smallest solid fix.\n\nSelected code:\n${selected}`;
    }
    return `Audit and fix the active file${path ? ` (${path})` : ""}. Preserve existing behavior unless it is clearly broken.`;
  }

  function setStatus(text) {
    const node = $("codexStatus");
    if (node) node.textContent = text;
  }

  function setBusy(busy) {
    state.busy = busy;
    ["codexRunBtn", "codexExplainBtn", "codexFixBtn", "codexReviewBtn", "codexApplyAllBtn", "codexTestWorker", "codexUndoBtn"].forEach(id => {
      const node = $(id);
      if (!node) return;
      if (id === "codexUndoBtn") node.disabled = busy || !state.undoStack.length;
      else node.disabled = busy;
    });
    $("codexProgress")?.classList.toggle("codex-hidden", !busy);
  }

  function isTextWorkspaceFile(file) {
    if (!file || typeof file.name !== "string" || typeof file.content !== "string") return false;
    if (file.content.includes("\u0000")) return false;
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|7z|rar|pdf|mp3|mp4|mov|avi|wasm|bin)$/i.test(file.name)) return false;
    if (/(^|\/)(node_modules|\.git|dist|build|coverage|\.wrangler|\.cache)(\/|$)/i.test(file.name)) return false;
    return file.content.length <= LIMITS.maxFileChars;
  }

  async function allTextFiles() {
    if (typeof getAllWorkspaceFiles !== "function") throw new Error("Workspace API getAllWorkspaceFiles() is unavailable.");
    return (await getAllWorkspaceFiles()).filter(isTextWorkspaceFile);
  }

  function activeFilePath() {
    return $("editor")?.dataset?.filename || "";
  }

  function manifestLike(name) {
    const base = name.split("/").pop();
    return new Set(["package.json", "wrangler.json", "wrangler.jsonc", "wrangler.toml", "vite.config.js", "vite.config.mjs", "README.md", "index.html", "schema.sql", "requirements.txt", "pyproject.toml"]).has(base);
  }

  function referencedPaths(activeContent, all) {
    const candidates = new Set();
    const refs = [];
    const re = /(?:from\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|(?:src|href)=["']([^"'#?]+))/g;
    let match;
    while ((match = re.exec(activeContent || ""))) refs.push(match[1] || match[2] || match[3]);
    const active = activeFilePath();
    const baseDir = active.includes("/") ? active.slice(0, active.lastIndexOf("/") + 1) : "";
    for (const ref of refs) {
      if (!ref || /^(https?:|data:|#)/i.test(ref)) continue;
      const cleaned = ref.replace(/^\.\//, "").replace(/[?#].*$/, "");
      const guessed = normalizeRelativePath(baseDir + cleaned);
      const variants = [guessed, `${guessed}.js`, `${guessed}.mjs`, `${guessed}.json`, `${guessed}/index.js`];
      for (const v of variants) if (all.some(f => f.name === v)) candidates.add(v);
    }
    return candidates;
  }

  function normalizeRelativePath(path) {
    const out = [];
    for (const part of String(path || "").replace(/\\/g, "/").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop(); else out.push(part);
    }
    return out.join("/");
  }

  function trimContext(files, priorities = new Set()) {
    const unique = new Map();
    for (const file of files) if (!unique.has(file.name)) unique.set(file.name, file);
    const sorted = [...unique.values()].sort((a, b) => {
      const ap = priorities.has(a.name) ? 1 : 0;
      const bp = priorities.has(b.name) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (manifestLike(a.name) !== manifestLike(b.name)) return manifestLike(a.name) ? -1 : 1;
      return a.content.length - b.content.length;
    });
    const out = [];
    let chars = 0;
    for (const file of sorted) {
      if (out.length >= LIMITS.maxFiles) break;
      const size = file.content.length + file.name.length + 80;
      if (chars + size > LIMITS.maxContextChars && !priorities.has(file.name)) continue;
      if (chars + size > LIMITS.maxContextChars) {
        const remaining = Math.max(0, LIMITS.maxContextChars - chars - file.name.length - 120);
        if (remaining > 3000) out.push({ name: file.name, content: file.content.slice(0, remaining) + "\n/* …context truncated by editor… */" });
        break;
      }
      out.push({ name: file.name, content: file.content });
      chars += size;
    }
    return out;
  }

  async function collectContext(mode) {
    const all = await allTextFiles();
    const active = activeFilePath();
    const activeObj = all.find(f => f.name === active);
    const priorities = new Set(active ? [active] : []);

    if (mode === "workspace") return trimContext(all, priorities);

    let selected = all.filter(file => file.name === active || manifestLike(file.name));
    if (mode === "smart" && activeObj) {
      const refs = referencedPaths(activeObj.content, all);
      refs.forEach(x => priorities.add(x));
      selected = selected.concat(all.filter(file => refs.has(file.name)));

      const terms = new Set((activeObj.content.match(/[A-Za-z_$][\w$]{4,}/g) || []).slice(0, 80));
      const related = all.filter(file => file.name !== active && !manifestLike(file.name) && [...terms].some(term => file.content.includes(term)));
      selected = selected.concat(related.slice(0, 18));
    }
    return trimContext(selected, priorities);
  }

  function currentSelection() {
    const editor = $("editor");
    if (!editor || editor.selectionStart === editor.selectionEnd) return "";
    return editor.value.slice(editor.selectionStart, editor.selectionEnd).slice(0, 25000);
  }

  async function runAi(forcedPrompt = "", readOnly = false) {
    if (state.busy) return;
    const { workerUrl, endpoint, appToken, model } = getSettings();
    const prompt = (forcedPrompt || $("codexPrompt").value).trim();
    if (!workerUrl) {
      $("codexSettingsCard").hidden = false;
      $("codexPanel").classList.add("open");
      setStatus("Add your Cloudflare Worker URL first.");
      return;
    }
    if (!prompt) return setStatus("Write a task first.");

    try {
      setBusy(true);
      clearChanges(false);
      $("codexResultCard").hidden = true;
      setStatus("Collecting project context…");
      const mode = $("codexContext").value;
      const files = await collectContext(mode);
      state.lastContextFiles = files;
      if (!files.length) throw new Error("No text files were available for the AI request.");
      const chars = files.reduce((n, f) => n + f.content.length, 0);
      setStatus(`Sending ${files.length} file(s) • ${(chars / 1000).toFixed(0)}k characters…`);

      const runUrl = resolveEndpoint(workerUrl, endpoint, "/api/ai/run");
      const response = await fetch(runUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(appToken ? { "X-Editor-AI-Token": appToken } : {}),
        },
        body: JSON.stringify({
          prompt,
          files,
          activeFile: activeFilePath(),
          selection: currentSelection(),
          readOnly,
          reasoningEffort: $("codexEffort").value,
          model: model || undefined,
          conversation: state.conversation.slice(-LIMITS.maxConversationTurns),
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Worker returned ${response.status}.`);

      const summary = String(data.summary || data.finalResponse || "Task complete.");
      const notes = Array.isArray(data.notes) ? data.notes.filter(Boolean) : [];
      $("codexResult").textContent = [summary, ...notes.map(n => `• ${n}`)].join("\n");
      $("codexResultCard").hidden = false;
      $("codexUsage").textContent = formatUsage(data.usage, data.model);
      state.pendingChanges = sanitizeChanges(data.changes);
      renderChanges();
      rememberTask(prompt, summary, state.pendingChanges.length);
      state.conversation.push({ role: "user", content: prompt }, { role: "assistant", content: summary });
      state.conversation = state.conversation.slice(-(LIMITS.maxConversationTurns * 2));
      writeJson(STORAGE.conversation, state.conversation);
      setStatus(`Done. ${state.pendingChanges.length} proposed file change(s).`);
    } catch (error) {
      console.error("Workspace AI request failed", error);
      setStatus(`Error: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function formatUsage(usage, model) {
    if (!usage && !model) return "";
    const parts = [];
    if (model) parts.push(`Model: ${model}`);
    if (usage?.input_tokens != null) parts.push(`input ${Number(usage.input_tokens).toLocaleString()} tokens`);
    if (usage?.output_tokens != null) parts.push(`output ${Number(usage.output_tokens).toLocaleString()} tokens`);
    return parts.join(" • ");
  }

  function sanitizeChanges(changes) {
    if (!Array.isArray(changes)) return [];
    const allowed = new Set(["created", "modified", "deleted"]);
    return changes.slice(0, 40).map(change => ({
      path: normalizeRelativePath(change?.path || ""),
      status: allowed.has(change?.status) ? change.status : "modified",
      content: change?.status === "deleted" ? "" : String(change?.content ?? ""),
      reason: String(change?.reason || ""),
    })).filter(change => change.path && !change.path.startsWith(".git/") && !change.path.includes("../"));
  }

  async function workspaceMap() {
    const files = typeof getAllWorkspaceFiles === "function" ? await getAllWorkspaceFiles() : [];
    return new Map(files.map(file => [file.name, typeof file.content === "string" ? file.content : ""]));
  }

  function renderChanges() {
    const card = $("codexChangesCard");
    const list = $("codexChanges");
    $("codexChangeCount").textContent = String(state.pendingChanges.length);
    if (!state.pendingChanges.length) {
      card.hidden = true;
      list.innerHTML = "";
      return;
    }

    list.innerHTML = state.pendingChanges.map((change, i) => `
      <div class="codex-change" data-change-index="${i}">
        <b>${esc(change.path)} <span class="codex-badge">${esc(change.status)}</span></b>
        <small>${esc(change.reason || (change.status === "deleted" ? "Delete file" : `${change.content.length.toLocaleString()} characters`))}</small>
        <div class="codex-change-actions">
          <button class="codex-btn" type="button" data-codex-preview="${i}">Preview diff</button>
          <button class="codex-btn good" type="button" data-codex-apply-one="${i}">Apply file</button>
          <button class="codex-btn danger" type="button" data-codex-reject-one="${i}">Reject</button>
        </div>
        <div class="codex-diff" data-codex-diff="${i}" hidden></div>
      </div>`).join("");

    list.querySelectorAll("[data-codex-preview]").forEach(btn => btn.onclick = () => toggleDiff(Number(btn.dataset.codexPreview)));
    list.querySelectorAll("[data-codex-apply-one]").forEach(btn => btn.onclick = () => applyOneChange(Number(btn.dataset.codexApplyOne)));
    list.querySelectorAll("[data-codex-reject-one]").forEach(btn => btn.onclick = () => rejectOneChange(Number(btn.dataset.codexRejectOne)));
    card.hidden = false;
  }

  async function toggleDiff(index) {
    const box = document.querySelector(`[data-codex-diff="${index}"]`);
    const change = state.pendingChanges[index];
    if (!box || !change) return;
    if (!box.hidden) { box.hidden = true; return; }
    const map = await workspaceMap();
    box.innerHTML = buildLineDiff(map.get(change.path) ?? "", change.status === "deleted" ? "" : change.content);
    box.hidden = false;
  }

  function buildLineDiff(before, after) {
    const a = String(before).split("\n");
    const b = String(after).split("\n");
    const max = Math.max(a.length, b.length);
    const lines = [];
    const cap = Math.min(max, 900);
    for (let i = 0; i < cap; i++) {
      if (a[i] === b[i]) {
        if (i < 12 || i > cap - 12) lines.push(`<span class="codex-diff-line codex-diff-same">  ${esc(a[i] ?? "")}</span>`);
        else if (i === 12) lines.push(`<span class="codex-diff-line codex-diff-same">  … unchanged lines hidden …</span>`);
      } else {
        if (a[i] !== undefined) lines.push(`<span class="codex-diff-line codex-diff-del">- ${esc(a[i])}</span>`);
        if (b[i] !== undefined) lines.push(`<span class="codex-diff-line codex-diff-add">+ ${esc(b[i])}</span>`);
      }
    }
    if (max > cap) lines.push(`<span class="codex-diff-line codex-diff-same">  … diff truncated after ${cap} lines …</span>`);
    return lines.join("") || `<span class="codex-diff-line codex-diff-same">  No textual difference.</span>`;
  }

  async function deleteWorkspaceFile(path) {
    if (typeof getDatabase !== "function") throw new Error("Workspace database API unavailable.");
    const db = await getDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").delete(path);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error(`Could not delete ${path}`));
      tx.onabort = () => reject(tx.error || new Error(`Delete aborted for ${path}`));
    });
  }

  async function applyChange(change) {
    if (!change?.path) return;
    if (change.status === "deleted") return deleteWorkspaceFile(change.path);
    if (typeof saveFileToDb !== "function") throw new Error("Workspace save API unavailable.");
    await saveFileToDb(change.path, String(change.content ?? ""));
  }

  async function captureUndo(changes) {
    const before = await workspaceMap();
    const snapshot = changes.map(change => ({
      path: change.path,
      existed: before.has(change.path),
      content: before.get(change.path) ?? "",
    }));
    state.undoStack.push(snapshot);
    if (state.undoStack.length > LIMITS.maxUndo) state.undoStack.shift();
    $("codexUndoBtn").disabled = false;
  }

  async function applyOneChange(index) {
    const change = state.pendingChanges[index];
    if (!change || state.busy) return;
    try {
      setBusy(true);
      await captureUndo([change]);
      await applyChange(change);
      const path = change.path;
      state.pendingChanges.splice(index, 1);
      await refreshWorkspaceAfterApply([path]);
      renderChanges();
      setStatus(`Applied ${path}. Review it before pushing to GitHub.`);
    } catch (error) {
      setStatus(`Apply failed: ${error.message}`);
    } finally { setBusy(false); }
  }

  async function applyAllChanges() {
    if (!state.pendingChanges.length || state.busy) return;
    try {
      setBusy(true);
      const changes = [...state.pendingChanges];
      await captureUndo(changes);
      for (const change of changes) await applyChange(change);
      const paths = changes.map(c => c.path);
      state.pendingChanges = [];
      await refreshWorkspaceAfterApply(paths);
      renderChanges();
      setStatus(`Applied ${paths.length} AI change(s) locally. Review them, then use your normal GitHub Push when ready.`);
    } catch (error) {
      setStatus(`Apply failed: ${error.message}`);
    } finally { setBusy(false); }
  }

  async function undoLastApply() {
    if (!state.undoStack.length || state.busy) return;
    const snapshot = state.undoStack.pop();
    try {
      setBusy(true);
      for (const item of snapshot) {
        if (item.existed) {
          if (typeof saveFileToDb !== "function") throw new Error("Workspace save API unavailable.");
          await saveFileToDb(item.path, item.content);
        } else {
          await deleteWorkspaceFile(item.path);
        }
      }
      await refreshWorkspaceAfterApply(snapshot.map(x => x.path));
      setStatus(`Undid ${snapshot.length} file change(s) from the last AI apply.`);
    } catch (error) {
      setStatus(`Undo failed: ${error.message}`);
    } finally { setBusy(false); }
  }

  function rejectOneChange(index) {
    if (!state.pendingChanges[index]) return;
    const path = state.pendingChanges[index].path;
    state.pendingChanges.splice(index, 1);
    renderChanges();
    setStatus(`Rejected proposed change to ${path}.`);
  }

  async function refreshWorkspaceAfterApply(paths = []) {
    if (typeof loadFiles === "function") { try { await loadFiles(); } catch (_) {} }
    const active = activeFilePath();
    if (active && paths.includes(active) && typeof openFile === "function") {
      try { await openFile(active); } catch (_) {}
    }
  }

  function clearChanges(updateStatus = true) {
    state.pendingChanges = [];
    if ($("codexChanges")) $("codexChanges").innerHTML = "";
    if ($("codexChangesCard")) $("codexChangesCard").hidden = true;
    if (updateStatus) setStatus("Proposed changes discarded.");
  }

  function rememberTask(prompt, summary, count) {
    state.history.unshift({ prompt, summary, count, at: Date.now() });
    state.history = state.history.slice(0, LIMITS.maxHistory);
    writeJson(STORAGE.history, state.history);
    renderHistory();
  }

  function renderHistory() {
    const list = $("codexHistoryList");
    if (!list) return;
    if (!state.history.length) { list.innerHTML = `<div class="codex-muted">No AI tasks yet.</div>`; return; }
    list.innerHTML = state.history.map((item, i) => `
      <div class="codex-history-item">
        <button type="button" data-history-index="${i}"><b>${esc(String(item.prompt || "").slice(0, 110))}</b><small>${new Date(item.at || Date.now()).toLocaleString()} • ${Number(item.count || 0)} change(s)</small></button>
      </div>`).join("");
    list.querySelectorAll("[data-history-index]").forEach(btn => btn.onclick = () => {
      const item = state.history[Number(btn.dataset.historyIndex)];
      if (!item) return;
      $("codexPrompt").value = item.prompt || "";
      $("codexResult").textContent = item.summary || "";
      $("codexResultCard").hidden = !item.summary;
      setStatus("Loaded task from history. Run it again to get fresh edits.");
    });
  }

  function clearHistory() {
    state.history = [];
    state.conversation = [];
    writeJson(STORAGE.history, []);
    writeJson(STORAGE.conversation, []);
    renderHistory();
    setStatus("AI task history cleared.");
  }

  function init() {
    injectStyles();
    injectUi();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
