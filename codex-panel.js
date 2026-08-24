/* RiftCity Mobile Workspace - Codex panel
   Drop this beside index.html and load it AFTER app-safari-v11.js + ide-v11.js.
*/
(() => {
  "use strict";

  const STORAGE = {
    url: "riftcity_codex_bridge_url",
    token: "riftcity_codex_bridge_token",
  };

  const state = {
    busy: false,
    pendingChanges: [],
  };

  const $ = (id) => document.getElementById(id);
  const esc = (value = "") => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  function injectStyles() {
    if ($("codexPanelStyles")) return;
    const style = document.createElement("style");
    style.id = "codexPanelStyles";
    style.textContent = `
      .codex-launch-btn{position:fixed;right:14px;bottom:14px;z-index:9997;border:1px solid #4b5563;background:#111827;color:#fff;border-radius:999px;padding:11px 15px;font-weight:800;box-shadow:0 12px 30px rgba(0,0,0,.35);cursor:pointer}
      .codex-panel{position:fixed;top:0;right:0;width:min(460px,100vw);height:100dvh;z-index:9999;background:#0b1020;color:#f8fafc;border-left:1px solid #263244;box-shadow:-18px 0 50px rgba(0,0,0,.45);display:flex;flex-direction:column;transform:translateX(102%);transition:transform .18s ease}
      .codex-panel.open{transform:translateX(0)}
      .codex-head{display:flex;align-items:center;gap:10px;padding:12px;border-bottom:1px solid #263244;background:#0f172a}
      .codex-head strong{flex:1;font-size:15px}.codex-head button{border:1px solid #334155;background:#111827;color:#fff;border-radius:8px;padding:8px 10px;cursor:pointer}
      .codex-body{flex:1;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
      .codex-card{border:1px solid #263244;background:#111827;border-radius:12px;padding:10px}
      .codex-label{display:block;font-size:11px;color:#94a3b8;margin:0 0 5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
      .codex-input,.codex-select,.codex-textarea{width:100%;box-sizing:border-box;border:1px solid #334155;background:#090f1d;color:#fff;border-radius:9px;padding:9px;font:inherit}
      .codex-textarea{min-height:150px;resize:vertical;line-height:1.4}
      .codex-row{display:flex;gap:8px}.codex-row>*{flex:1;min-width:0}
      .codex-actions{display:flex;gap:8px;flex-wrap:wrap}.codex-btn{border:1px solid #3b4a61;background:#182235;color:#fff;border-radius:9px;padding:9px 11px;font-weight:800;cursor:pointer}.codex-btn.primary{background:#2563eb;border-color:#3b82f6}.codex-btn.good{background:#166534;border-color:#22c55e}.codex-btn:disabled{opacity:.5;cursor:not-allowed}
      .codex-status{font-size:12px;color:#cbd5e1;white-space:pre-wrap;line-height:1.45}
      .codex-result{white-space:pre-wrap;font-size:13px;line-height:1.45;color:#e2e8f0}
      .codex-change{border:1px solid #334155;border-radius:9px;padding:8px;margin-top:7px;background:#0b1220}.codex-change b{display:block;overflow-wrap:anywhere}.codex-change small{color:#94a3b8}
      .codex-badge{display:inline-block;padding:2px 6px;border-radius:99px;background:#1e293b;color:#cbd5e1;font-size:10px;margin-left:5px}
      @media(max-width:700px){.codex-panel{width:100vw;border-left:0}.codex-launch-btn{right:10px;bottom:10px}}
    `;
    document.head.appendChild(style);
  }

  function injectUi() {
    if ($("codexPanel")) return;

    const launch = document.createElement("button");
    launch.id = "codexLaunchBtn";
    launch.className = "codex-launch-btn";
    launch.textContent = "✦ Codex";
    launch.addEventListener("click", () => $("codexPanel").classList.add("open"));
    document.body.appendChild(launch);

    const panel = document.createElement("aside");
    panel.id = "codexPanel";
    panel.className = "codex-panel";
    panel.innerHTML = `
      <div class="codex-head">
        <strong>✦ Codex</strong>
        <button id="codexSettingsBtn" type="button">Settings</button>
        <button id="codexCloseBtn" type="button">✕</button>
      </div>
      <div class="codex-body">
        <div class="codex-card" id="codexSettingsCard" hidden>
          <label class="codex-label" for="codexBridgeUrl">Bridge URL</label>
          <input class="codex-input" id="codexBridgeUrl" placeholder="https://your-codex-server.example.com">
          <div style="height:8px"></div>
          <label class="codex-label" for="codexBridgeToken">Bridge token</label>
          <input class="codex-input" id="codexBridgeToken" type="password" placeholder="Your private bridge token">
          <div style="height:8px"></div>
          <button class="codex-btn" id="codexSaveSettings" type="button">Save settings</button>
        </div>

        <div class="codex-card">
          <div class="codex-row">
            <div>
              <label class="codex-label" for="codexContext">Context</label>
              <select class="codex-select" id="codexContext">
                <option value="workspace">Whole workspace</option>
                <option value="active">Active file + project manifest</option>
              </select>
            </div>
            <div>
              <label class="codex-label" for="codexEffort">Reasoning</label>
              <select class="codex-select" id="codexEffort">
                <option value="medium">Medium</option>
                <option value="high" selected>High</option>
                <option value="xhigh">XHigh</option>
              </select>
            </div>
          </div>
          <div style="height:9px"></div>
          <label class="codex-label" for="codexPrompt">Task</label>
          <textarea class="codex-textarea" id="codexPrompt" placeholder="Example: Audit this editor and fix the mobile tab close bug. Keep existing GitHub behavior intact."></textarea>
          <div style="height:9px"></div>
          <div class="codex-actions">
            <button class="codex-btn primary" id="codexRunBtn" type="button">Run Codex</button>
            <button class="codex-btn" id="codexExplainBtn" type="button">Explain active file</button>
            <button class="codex-btn" id="codexFixBtn" type="button">Fix selection/file</button>
          </div>
        </div>

        <div class="codex-card">
          <span class="codex-label">Status</span>
          <div class="codex-status" id="codexStatus">Ready.</div>
        </div>

        <div class="codex-card" id="codexResultCard" hidden>
          <span class="codex-label">Codex response</span>
          <div class="codex-result" id="codexResult"></div>
        </div>

        <div class="codex-card" id="codexChangesCard" hidden>
          <span class="codex-label">Proposed workspace changes</span>
          <div id="codexChanges"></div>
          <div style="height:9px"></div>
          <div class="codex-actions">
            <button class="codex-btn good" id="codexApplyAllBtn" type="button">Apply all</button>
            <button class="codex-btn" id="codexDiscardBtn" type="button">Discard</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    $("codexBridgeUrl").value = localStorage.getItem(STORAGE.url) || "";
    $("codexBridgeToken").value = localStorage.getItem(STORAGE.token) || "";

    $("codexCloseBtn").onclick = () => panel.classList.remove("open");
    $("codexSettingsBtn").onclick = () => {
      $("codexSettingsCard").hidden = !$("codexSettingsCard").hidden;
    };
    $("codexSaveSettings").onclick = saveSettings;
    $("codexRunBtn").onclick = () => runCodex();
    $("codexExplainBtn").onclick = () => runCodex("Explain the active file. Focus on what it does, important dependencies, and likely bugs. Do not modify files.", true);
    $("codexFixBtn").onclick = () => runCodex(buildFixPrompt());
    $("codexApplyAllBtn").onclick = applyAllChanges;
    $("codexDiscardBtn").onclick = clearChanges;
  }

  function saveSettings() {
    const url = $("codexBridgeUrl").value.trim().replace(/\/$/, "");
    const token = $("codexBridgeToken").value.trim();
    localStorage.setItem(STORAGE.url, url);
    localStorage.setItem(STORAGE.token, token);
    setStatus("Settings saved.");
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
    ["codexRunBtn", "codexExplainBtn", "codexFixBtn", "codexApplyAllBtn"].forEach(id => {
      const node = $(id);
      if (node) node.disabled = busy;
    });
  }

  function isTextWorkspaceFile(file) {
    if (!file || typeof file.name !== "string" || typeof file.content !== "string") return false;
    if (file.content.startsWith("data:application/octet-stream;base64,")) return false;
    return file.content.length <= 1_500_000;
  }

  async function collectContext(mode) {
    if (typeof getAllWorkspaceFiles !== "function") {
      throw new Error("Workspace API getAllWorkspaceFiles() is unavailable.");
    }

    const all = (await getAllWorkspaceFiles()).filter(isTextWorkspaceFile);
    if (mode === "workspace") return all.map(({ name, content }) => ({ name, content }));

    const active = $("editor")?.dataset?.filename || "";
    const manifestNames = new Set([
      "package.json", "wrangler.json", "wrangler.jsonc", "wrangler.toml",
      "vite.config.js", "README.md", "index.html"
    ]);

    return all
      .filter(file => file.name === active || manifestNames.has(file.name) || manifestNames.has(file.name.split("/").pop()))
      .map(({ name, content }) => ({ name, content }));
  }

  async function runCodex(forcedPrompt = "", readOnly = false) {
    if (state.busy) return;

    const bridgeUrl = (localStorage.getItem(STORAGE.url) || "").replace(/\/$/, "");
    const bridgeToken = localStorage.getItem(STORAGE.token) || "";
    const prompt = (forcedPrompt || $("codexPrompt").value).trim();

    if (!bridgeUrl) {
      $("codexSettingsCard").hidden = false;
      $("codexPanel").classList.add("open");
      setStatus("Add your Codex bridge URL first.");
      return;
    }
    if (!prompt) {
      setStatus("Write a task first.");
      return;
    }

    try {
      setBusy(true);
      clearChanges();
      $("codexResultCard").hidden = true;
      setStatus("Collecting workspace…");
      const files = await collectContext($("codexContext").value);
      if (!files.length) throw new Error("No text files were available for Codex.");

      setStatus(`Sending ${files.length} file(s) to Codex…`);
      const response = await fetch(`${bridgeUrl}/api/codex/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bridgeToken ? { "X-Codex-Bridge-Token": bridgeToken } : {}),
        },
        body: JSON.stringify({
          prompt,
          files,
          readOnly,
          reasoningEffort: $("codexEffort").value,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Codex bridge returned ${response.status}.`);

      $("codexResult").textContent = data.finalResponse || "Codex finished without a text response.";
      $("codexResultCard").hidden = false;
      state.pendingChanges = Array.isArray(data.changes) ? data.changes : [];
      renderChanges();
      setStatus(`Done. ${state.pendingChanges.length} proposed file change(s).`);
    } catch (error) {
      console.error("Codex run failed", error);
      setStatus(`Error: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function renderChanges() {
    const card = $("codexChangesCard");
    const list = $("codexChanges");
    if (!state.pendingChanges.length) {
      card.hidden = true;
      list.innerHTML = "";
      return;
    }

    list.innerHTML = state.pendingChanges.map((change, i) => `
      <div class="codex-change">
        <b>${esc(change.path)} <span class="codex-badge">${esc(change.status || "modified")}</span></b>
        <small>${change.status === "deleted" ? "Will delete this file" : `${String(change.content || "").length.toLocaleString()} characters`}</small>
        <div style="height:6px"></div>
        <button class="codex-btn" type="button" data-codex-apply-one="${i}">Apply this file</button>
      </div>
    `).join("");

    list.querySelectorAll("[data-codex-apply-one]").forEach(btn => {
      btn.onclick = () => applyOneChange(Number(btn.dataset.codexApplyOne));
    });
    card.hidden = false;
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
    if (change.status === "deleted") {
      await deleteWorkspaceFile(change.path);
      return;
    }
    if (typeof saveFileToDb !== "function") throw new Error("Workspace save API unavailable.");
    await saveFileToDb(change.path, String(change.content ?? ""));
  }

  async function applyOneChange(index) {
    const change = state.pendingChanges[index];
    if (!change) return;
    try {
      setBusy(true);
      await applyChange(change);
      state.pendingChanges.splice(index, 1);
      await refreshWorkspaceAfterApply(change.path);
      renderChanges();
      setStatus(`Applied ${change.path}.`);
    } catch (error) {
      setStatus(`Apply failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function applyAllChanges() {
    if (!state.pendingChanges.length) return;
    try {
      setBusy(true);
      const changedPaths = [];
      for (const change of state.pendingChanges) {
        await applyChange(change);
        changedPaths.push(change.path);
      }
      state.pendingChanges = [];
      await refreshWorkspaceAfterApply(changedPaths[0]);
      renderChanges();
      setStatus(`Applied ${changedPaths.length} file change(s) to the local workspace. Review them before pushing to GitHub.`);
    } catch (error) {
      setStatus(`Apply failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshWorkspaceAfterApply(firstPath) {
    if (typeof loadFiles === "function") {
      try { await loadFiles(); } catch (_) {}
    }
    const active = $("editor")?.dataset?.filename || "";
    if (active && typeof openFile === "function") {
      const changed = state.pendingChanges.some(change => change.path === active) || active === firstPath;
      if (changed) {
        try { await openFile(active); } catch (_) {}
      }
    }
  }

  function clearChanges() {
    state.pendingChanges = [];
    if ($("codexChanges")) $("codexChanges").innerHTML = "";
    if ($("codexChangesCard")) $("codexChangesCard").hidden = true;
  }

  function init() {
    injectStyles();
    injectUi();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
