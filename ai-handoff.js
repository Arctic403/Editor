/* Mobile Workspace AI handoff
   Local-only bridge: export the current IndexedDB workspace, import a structured
   text patch, review it, then apply it to the local workspace. GitHub push stays
   manual and continues to use the editor's existing Git sync flow.
*/
(() => {
  "use strict";

  const FORMAT_WORKSPACE = "riftcity-ai-workspace";
  const FORMAT_PATCH = "riftcity-ai-patch";
  const VERSION = 1;
  const MAX_CHANGES = 100;
  const MAX_FILE_BYTES = 2_000_000;
  const MAX_TOTAL_BYTES = 10_000_000;
  const PENDING_DB = "RiftCityAIHandoffDB_v1";
  const PENDING_STORE = "patches";
  const PENDING_KEY = "pending";
  const encoder = new TextEncoder();

  const LEGACY_AI_KEYS = [
    "riftcity_ai_worker_url",
    "riftcity_ai_provider_v1",
    "riftcity_codex_host_url_v1",
    "riftcity_codex_bridge_token_v1",
    "riftcity_ai_app_token",
    "riftcity_ai_task_history_v2",
    "riftcity_ai_conversation_v2",
    "riftcity_ai_model_v2",
    "riftcity_ai_endpoint_v1",
    "riftcity_ai_health_endpoint_v1",
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (value = "") => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  function cleanLegacyAiSettings() {
    for (const key of LEGACY_AI_KEYS) {
      try { localStorage.removeItem(key); } catch (_) {}
    }
  }

  function normalizePath(value) {
    const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!raw) throw new Error("Patch contains an empty file path.");
    const parts = raw.split("/").filter(Boolean);
    if (!parts.length || parts.some((part) => part === "." || part === "..")) {
      throw new Error(`Unsafe file path: ${raw}`);
    }
    const normalized = parts.join("/");
    const lower = normalized.toLowerCase();
    if (lower === ".git" || lower.startsWith(".git/") || lower === "node_modules" || lower.startsWith("node_modules/")) {
      throw new Error(`Protected path cannot be changed: ${normalized}`);
    }
    if (isSecretLikePath(normalized)) {
      throw new Error(`Secret/credential-like path is blocked from AI patches: ${normalized}`);
    }
    return normalized;
  }

  function isSecretLikePath(path) {
    const normalized = String(path || "").replace(/\\/g, "/");
    const base = normalized.split("/").pop() || "";
    return /^(?:\.env)(?:\..*)?$/i.test(base)
      || /^(?:\.npmrc|\.pypirc|id_rsa|id_ed25519)$/i.test(base)
      || /\.(?:pem|key|p12|pfx)$/i.test(base);
  }

  function isBinaryWorkspaceValue(value) {
    return typeof value === "string" && /^data:[^;,]*;base64,/i.test(value);
  }

  async function sha256(text) {
    const bytes = encoder.encode(String(text));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function snapshotHash(files) {
    const rows = [];
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push(`${file.path}\0${file.sha256}`);
    }
    return sha256(rows.join("\n"));
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function saveDirtyEditorIfNeeded() {
    const editor = $("editor");
    const path = editor?.dataset?.filename || "";
    if (!path || typeof saveFileToDb !== "function") return;
    if (typeof isDirty !== "undefined" && !isDirty) return;
    await saveFileToDb(path, editor.value);
    if (typeof updateDirtyIndicator === "function") updateDirtyIndicator(false);
  }

  async function exportWorkspaceForAi() {
    if (typeof getAllWorkspaceFiles !== "function") {
      throw new Error("Workspace read API is unavailable.");
    }
    await saveDirtyEditorIfNeeded();
    const sourceFiles = await getAllWorkspaceFiles();
    const files = [];
    const omitted = [];
    let totalBytes = 0;

    for (const file of sourceFiles) {
      const path = String(file?.name || "");
      if (!path) continue;
      if (isSecretLikePath(path)) {
        omitted.push({ path, reason: "secret-like path" });
        continue;
      }
      const content = typeof file.content === "string" ? file.content : String(file.content ?? "");
      if (isBinaryWorkspaceValue(content)) {
        omitted.push({ path, reason: "binary/data URL" });
        continue;
      }
      const bytes = encoder.encode(content).byteLength;
      totalBytes += bytes;
      files.push({ path, sha256: await sha256(content), content });
    }

    const repo = $("repoSelect")?.value || "";
    const branch = $("branchSelect")?.value || "";
    const snapshot = await snapshotHash(files);
    const payload = {
      format: FORMAT_WORKSPACE,
      version: VERSION,
      exported_at: new Date().toISOString(),
      repo: repo || null,
      branch: branch || null,
      snapshot_sha256: snapshot,
      file_count: files.length,
      text_bytes: totalBytes,
      files,
      omitted,
      patch_contract: {
        format: FORMAT_PATCH,
        version: VERSION,
        actions: ["write", "delete"],
        note: "For existing files, set base_sha256 to the matching exported file sha256. For a new file, set base_sha256 to null."
      }
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`workspace-ai-export-${stamp}.json`, JSON.stringify(payload, null, 2));
    return { files: files.length, omitted: omitted.length, bytes: totalBytes };
  }

  function extractJsonText(text) {
    const raw = String(text || "").trim();
    if (!raw) throw new Error("Patch file is empty.");
    return raw;
  }

  function normalizePatch(rawPayload) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      throw new Error("Patch must be one JSON object.");
    }
    if (rawPayload.format && rawPayload.format !== FORMAT_PATCH) {
      throw new Error(`Unsupported patch format: ${rawPayload.format}`);
    }
    if (rawPayload.version !== VERSION) {
      throw new Error(`Patch version must be ${VERSION}.`);
    }
    if (!Array.isArray(rawPayload.changes) || rawPayload.changes.length === 0) {
      throw new Error("Patch has no changes.");
    }
    if (rawPayload.changes.length > MAX_CHANGES) {
      throw new Error(`Patch exceeds the ${MAX_CHANGES}-file limit.`);
    }

    let totalBytes = 0;
    const seen = new Set();
    const changes = rawPayload.changes.map((input) => {
      const action = input?.action === "write" ? "write" : input?.action === "delete" ? "delete" : "";
      if (!action) throw new Error("Every change action must be write or delete.");
      const path = normalizePath(input.path);
      if (seen.has(path)) throw new Error(`Patch repeats the same path: ${path}`);
      seen.add(path);

      const output = { action, path };
      if (Object.prototype.hasOwnProperty.call(input, "base_sha256")) {
        if (input.base_sha256 !== null && !/^[a-f0-9]{64}$/i.test(String(input.base_sha256))) {
          throw new Error(`Invalid base_sha256 for ${path}.`);
        }
        output.base_sha256 = input.base_sha256 === null ? null : String(input.base_sha256).toLowerCase();
      }
      if (input.reason != null) output.reason = String(input.reason).slice(0, 500);

      if (action === "write") {
        if (typeof input.content !== "string") throw new Error(`Write change is missing text content: ${path}`);
        const bytes = encoder.encode(input.content).byteLength;
        if (bytes > MAX_FILE_BYTES) throw new Error(`${path} exceeds the ${MAX_FILE_BYTES}-byte per-file patch limit.`);
        totalBytes += bytes;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Patch exceeds the ${MAX_TOTAL_BYTES}-byte total text limit.`);
        output.content = input.content;
      }
      return output;
    });

    return {
      format: FORMAT_PATCH,
      version: VERSION,
      title: String(rawPayload.title || rawPayload.commit_message || "AI patch").slice(0, 160),
      base_snapshot_sha256: rawPayload.base_snapshot_sha256 || null,
      created_at: rawPayload.created_at || new Date().toISOString(),
      changes,
    };
  }

  async function parsePatchText(text) {
    const raw = extractJsonText(text);
    let parsed;

    // Parse a normal JSON patch first. This is critical because file contents
    // may legitimately contain Markdown fence markers.
    try {
      parsed = JSON.parse(raw);
      return normalizePatch(parsed);
    } catch (directError) {
      // Optional fallback for a patch pasted inside one Markdown JSON fence.
      // Build the fence marker dynamically so this source file does not itself
      // contain the marker sequence and confuse older importers.
      const fence = String.fromCharCode(96).repeat(3);
      const first = raw.indexOf(fence);
      if (first < 0) throw new Error(`Patch JSON is invalid: ${directError.message}`);

      let contentStart = first + fence.length;
      if (raw.slice(contentStart, contentStart + 4).toLowerCase() === "json") contentStart += 4;
      while (/\s/.test(raw.charAt(contentStart))) contentStart += 1;

      const last = raw.lastIndexOf(fence);
      if (last <= contentStart) throw new Error(`Patch JSON is invalid: ${directError.message}`);

      try {
        parsed = JSON.parse(raw.slice(contentStart, last).trim());
      } catch (fencedError) {
        throw new Error(`Patch JSON is invalid: ${fencedError.message}`);
      }
      return normalizePatch(parsed);
    }
  }

  function openPendingDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(PENDING_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PENDING_STORE)) db.createObjectStore(PENDING_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open patch storage."));
    });
  }

  async function setPendingPatch(patch) {
    const db = await openPendingDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(PENDING_STORE, "readwrite");
        tx.objectStore(PENDING_STORE).put({ id: PENDING_KEY, patch, saved_at: new Date().toISOString() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("Could not save pending patch."));
        tx.onabort = () => reject(tx.error || new Error("Saving pending patch was aborted."));
      });
    } finally { db.close(); }
  }

  async function getPendingPatch() {
    const db = await openPendingDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(PENDING_STORE, "readonly");
        const req = tx.objectStore(PENDING_STORE).get(PENDING_KEY);
        req.onsuccess = () => resolve(req.result?.patch || null);
        req.onerror = () => reject(req.error || new Error("Could not read pending patch."));
      });
    } finally { db.close(); }
  }

  async function clearPendingPatch() {
    const db = await openPendingDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(PENDING_STORE, "readwrite");
        tx.objectStore(PENDING_STORE).delete(PENDING_KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("Could not clear pending patch."));
      });
    } finally { db.close(); }
  }

  async function previewPatch(patch) {
    const files = typeof getAllWorkspaceFiles === "function" ? await getAllWorkspaceFiles() : [];
    const current = new Map(files.map((file) => [String(file.name), String(file.content ?? "")]));
    const rows = [];

    for (const change of patch.changes) {
      const exists = current.has(change.path);
      const oldContent = exists ? current.get(change.path) : null;
      const oldHash = exists ? await sha256(oldContent) : null;
      const hasBase = Object.prototype.hasOwnProperty.call(change, "base_sha256");
      let conflict = false;
      let conflictReason = "";

      if (hasBase) {
        if (change.base_sha256 === null && exists) {
          conflict = true;
          conflictReason = "Patch expected this file to be new, but it already exists.";
        } else if (change.base_sha256 !== null && !exists) {
          conflict = true;
          conflictReason = "Patch expected this file to exist, but it is missing.";
        } else if (change.base_sha256 !== null && oldHash !== change.base_sha256) {
          conflict = true;
          conflictReason = "Local file changed since the workspace export used to build this patch.";
        }
      }

      let status = "unchanged";
      if (conflict) status = "conflict";
      else if (change.action === "delete") status = exists ? "delete" : "unchanged";
      else if (!exists) status = "create";
      else if (oldContent !== change.content) status = "modify";

      rows.push({ ...change, exists, oldHash, hasBase, status, conflict, conflictReason });
    }

    const counts = rows.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, { create: 0, modify: 0, delete: 0, unchanged: 0, conflict: 0 });
    return { rows, counts };
  }

  function ensureModal() {
    if ($("aiPatchModal")) return;
    const modal = document.createElement("div");
    modal.id = "aiPatchModal";
    modal.className = "ai-patch-overlay hidden";
    modal.innerHTML = `
      <section class="ai-patch-dialog" role="dialog" aria-modal="true" aria-labelledby="aiPatchTitle">
        <div class="ai-patch-head">
          <div>
            <strong id="aiPatchTitle">AI Patch Review</strong>
            <div class="ai-patch-sub" id="aiPatchSubtitle">No pending patch</div>
          </div>
          <button class="btn btn-sm btn-secondary" id="aiPatchCloseBtn" type="button">✕</button>
        </div>
        <div class="ai-patch-summary" id="aiPatchSummary"></div>
        <div class="ai-patch-list" id="aiPatchList"></div>
        <div class="ai-patch-actions">
          <button class="btn btn-danger" id="aiPatchDiscardBtn" type="button">Discard Patch</button>
          <button class="btn btn-secondary" id="aiPatchCloseFooterBtn" type="button">Close</button>
          <button class="btn btn-success" id="aiPatchApplyBtn" type="button">Apply All Locally</button>
        </div>
        <div class="ai-patch-note">Applying changes only updates this browser workspace. GitHub is not touched until you use the normal Push Changes button.</div>
      </section>`;
    document.body.appendChild(modal);
    $("aiPatchCloseBtn").addEventListener("click", closeReview);
    $("aiPatchCloseFooterBtn").addEventListener("click", closeReview);
    modal.addEventListener("click", (event) => { if (event.target === modal) closeReview(); });
    $("aiPatchDiscardBtn").addEventListener("click", async () => {
      if (!confirm("Discard the pending AI patch? No workspace files will be changed.")) return;
      await clearPendingPatch();
      updatePendingButton(null);
      closeReview();
    });
    $("aiPatchApplyBtn").addEventListener("click", applyPendingPatch);
  }

  function closeReview() {
    $("aiPatchModal")?.classList.add("hidden");
  }

  function updatePendingButton(patch) {
    const btn = $("reviewAiPatchBtn");
    if (!btn) return;
    if (patch?.changes?.length) {
      btn.classList.remove("hidden");
      btn.textContent = `🧩 Review Patch (${patch.changes.length})`;
    } else {
      btn.classList.add("hidden");
      btn.textContent = "🧩 Review Patch";
    }
  }

  function statusLabel(status) {
    return ({ create: "CREATE", modify: "MODIFY", delete: "DELETE", unchanged: "NO CHANGE", conflict: "CONFLICT" })[status] || status.toUpperCase();
  }

  async function renderReview(patch) {
    ensureModal();
    const preview = await previewPatch(patch);
    $("aiPatchTitle").textContent = patch.title || "AI Patch Review";
    $("aiPatchSubtitle").textContent = `${patch.changes.length} requested file operation${patch.changes.length === 1 ? "" : "s"}`;
    $("aiPatchSummary").innerHTML = [
      ["create", preview.counts.create], ["modify", preview.counts.modify], ["delete", preview.counts.delete],
      ["unchanged", preview.counts.unchanged], ["conflict", preview.counts.conflict]
    ].filter(([, count]) => count).map(([key, count]) => `<span class="ai-patch-chip ${key}">${count} ${esc(key)}</span>`).join("") || '<span class="ai-patch-chip unchanged">No changes</span>';

    $("aiPatchList").innerHTML = preview.rows.map((row) => `
      <div class="ai-patch-row ${esc(row.status)}">
        <div class="ai-patch-row-top">
          <span class="ai-patch-status">${esc(statusLabel(row.status))}</span>
          <code>${esc(row.path)}</code>
        </div>
        ${row.reason ? `<div class="ai-patch-reason">${esc(row.reason)}</div>` : ""}
        ${row.conflictReason ? `<div class="ai-patch-conflict">${esc(row.conflictReason)}</div>` : ""}
        ${!row.hasBase && row.status !== "unchanged" ? '<div class="ai-patch-unverified">No base hash supplied — review this file carefully.</div>' : ""}
      </div>`).join("");

    const actionable = preview.counts.create + preview.counts.modify + preview.counts.delete;
    const applyBtn = $("aiPatchApplyBtn");
    applyBtn.disabled = preview.counts.conflict > 0 || actionable === 0;
    applyBtn.textContent = preview.counts.conflict > 0 ? "Resolve Conflicts First" : `Apply ${actionable} Change${actionable === 1 ? "" : "s"} Locally`;
    $("aiPatchModal").classList.remove("hidden");
    return preview;
  }

  async function openReview() {
    const patch = await getPendingPatch();
    if (!patch) return alert("No pending AI patch. Import a patch file first.");
    await renderReview(patch);
  }

  function parentFolders(path) {
    const parts = String(path).split("/");
    parts.pop();
    const result = [];
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (current) result.push(current);
    }
    return result;
  }

  async function applyPatchTransaction(preview) {
    const database = await getDatabase();
    const stores = database.objectStoreNames.contains("folders") ? ["files", "folders"] : ["files"];
    await new Promise((resolve, reject) => {
      const tx = database.transaction(stores, "readwrite");
      const fileStore = tx.objectStore("files");
      const folderStore = stores.includes("folders") ? tx.objectStore("folders") : null;
      const folderSet = new Set();

      for (const row of preview.rows) {
        if (row.status === "create" || row.status === "modify") {
          fileStore.put({ name: row.path, content: row.content });
          for (const folder of parentFolders(row.path)) folderSet.add(folder);
        } else if (row.status === "delete") {
          fileStore.delete(row.path);
        }
      }
      if (folderStore) for (const folder of folderSet) folderStore.put({ path: folder });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Patch transaction failed."));
      tx.onabort = () => reject(tx.error || new Error("Patch transaction was aborted."));
    });
  }

  async function applyPendingPatch() {
    const button = $("aiPatchApplyBtn");
    if (button?.disabled) return;
    const patch = await getPendingPatch();
    if (!patch) return alert("Pending patch is missing.");
    const preview = await previewPatch(patch);
    if (preview.counts.conflict) {
      await renderReview(patch);
      return alert("The workspace changed after this patch was prepared. Re-export the workspace and get a fresh patch instead of overwriting newer work.");
    }
    const actionable = preview.counts.create + preview.counts.modify + preview.counts.delete;
    if (!actionable) return alert("This patch does not change the current workspace.");
    if (!confirm(`Apply ${actionable} reviewed change(s) to the local workspace?\n\nGitHub will NOT be pushed automatically.`)) return;

    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = "Applying…";
    try {
      const activePath = $("editor")?.dataset?.filename || "";
      await applyPatchTransaction(preview);
      if (typeof workspaceHashCache !== "undefined" && workspaceHashCache?.delete) {
        for (const row of preview.rows) workspaceHashCache.delete(row.path);
      }
      await clearPendingPatch();
      updatePendingButton(null);
      if (activePath) {
        const touched = preview.rows.find((row) => row.path === activePath && row.status !== "unchanged");
        if (touched?.status === "delete" && typeof closeCurrentFile === "function") closeCurrentFile();
        else if (touched && typeof openFile === "function") await openFile(activePath);
      }
      if (typeof loadFiles === "function") await loadFiles();
      if (typeof scheduleGitSyncStatusUpdate === "function") scheduleGitSyncStatusUpdate();
      closeReview();
      alert(`Applied ${actionable} change(s) to the local workspace.\n\nReview anything you want, then use the normal Push Changes button when you're ready.`);
    } catch (error) {
      console.error("AI patch apply failed", error);
      button.disabled = false;
      button.textContent = previousText;
      alert("Could not apply patch: " + (error.message || error));
    }
  }

  async function importPatchFile(file) {
    if (!file) return;
    const text = await file.text();
    const patch = await parsePatchText(text);
    await setPendingPatch(patch);
    updatePendingButton(patch);
    await renderReview(patch);
  }

  function bindUi() {
    ensureModal();
    const exportBtn = $("exportAiWorkspaceBtn");
    const importBtn = $("importAiPatchBtn");
    const reviewBtn = $("reviewAiPatchBtn");
    const input = $("aiPatchInput");

    exportBtn?.addEventListener("click", async () => {
      const old = exportBtn.textContent;
      exportBtn.disabled = true;
      exportBtn.textContent = "Exporting…";
      try {
        const result = await exportWorkspaceForAi();
        const omitted = result.omitted ? ` ${result.omitted} binary/secret file(s) were intentionally omitted.` : "";
        alert(`AI workspace export created with ${result.files} text file(s).${omitted}\n\nSend that JSON file to ChatGPT when you want a patch.`);
      } catch (error) {
        console.error(error);
        alert("AI workspace export failed: " + (error.message || error));
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = old;
      }
    });

    importBtn?.addEventListener("click", () => input?.click());
    reviewBtn?.addEventListener("click", () => openReview().catch((error) => alert(error.message || error)));
    input?.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      try { await importPatchFile(file); }
      catch (error) {
        console.error(error);
        alert("Patch import failed: " + (error.message || error));
      }
    });
  }

  async function init() {
    cleanLegacyAiSettings();
    bindUi();
    try { updatePendingButton(await getPendingPatch()); }
    catch (error) { console.warn("Pending AI patch restore failed", error); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
