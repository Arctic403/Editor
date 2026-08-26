/* Mobile Workspace AI handoff
   Local-only bridge: export the current IndexedDB workspace, import a structured
   text patch, review/cherry-pick it, then apply it to the local workspace.
   GitHub push stays manual and continues to use the editor's existing Git sync flow.
*/
(() => {
  "use strict";

  const FORMAT_WORKSPACE = "riftcity-ai-workspace";
  const FORMAT_PATCH = "riftcity-ai-patch";
  const WORKSPACE_VERSION = 1;
  const PATCH_VERSION = 2;
  const LEGACY_PATCH_VERSION = 1;
  const MAX_CHANGES = 100;
  const MAX_FILE_BYTES = 2_000_000;
  const MAX_TOTAL_BYTES = 10_000_000;
  const LARGE_JSON_WARNING_BYTES = 2_500_000;
  const PENDING_DB = "RiftCityAIHandoffDB_v1";
  const PENDING_STORE = "patches";
  const PENDING_KEY = "pending";
  const encoder = new TextEncoder();
  const ACTIONABLE = new Set(["create", "modify", "delete", "move"]);

  let currentPreview = null;

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

  async function collectWorkspaceTextFiles() {
    if (typeof getAllWorkspaceFiles !== "function") throw new Error("Workspace read API is unavailable.");
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
    return { files, omitted, totalBytes };
  }

  async function currentWorkspaceSnapshotHash() {
    const { files } = await collectWorkspaceTextFiles();
    return snapshotHash(files);
  }

  function patchContract(repo, branch) {
    return {
      format: FORMAT_PATCH,
      version: PATCH_VERSION,
      accepts_legacy_version: LEGACY_PATCH_VERSION,
      actions: ["write", "delete", "move"],
      rename_alias: true,
      target_repo: repo || null,
      target_branch: branch || null,
      note: "Include target_repo, target_branch, and base_snapshot_sha256 from this export. Existing-file write/delete/move actions should include that file's base_sha256. New write actions use base_sha256:null. Move uses path as the source and new_path as the destination; optional content may modify the file while moving it."
    };
  }

  async function assertPatchTargetMatchesWorkspace(patch) {
    const repo = $("repoSelect")?.value || "";
    const branch = $("branchSelect")?.value || "";
    if (patch.target_repo && repo && patch.target_repo !== repo) {
      throw new Error(`Patch targets ${patch.target_repo}, but the editor is currently on ${repo}.`);
    }
    if (patch.target_branch && branch && patch.target_branch !== branch) {
      throw new Error(`Patch targets branch ${patch.target_branch}, but the editor is currently on ${branch}.`);
    }
  }

  function downloadBlob(filename, blob) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  }

  function downloadText(filename, text) {
    downloadBlob(filename, new Blob([text], { type: "application/json;charset=utf-8" }));
  }

  function exportStamp() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
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
    const { files, omitted, totalBytes } = await collectWorkspaceTextFiles();
    const repo = $("repoSelect")?.value || "";
    const branch = $("branchSelect")?.value || "";
    const snapshot = await snapshotHash(files);
    const payload = {
      format: FORMAT_WORKSPACE,
      version: WORKSPACE_VERSION,
      exported_at: new Date().toISOString(),
      repo: repo || null,
      branch: branch || null,
      snapshot_sha256: snapshot,
      file_count: files.length,
      text_bytes: totalBytes,
      files,
      omitted,
      patch_contract: patchContract(repo, branch),
    };
    downloadText(`workspace-ai-export-${exportStamp()}.json`, JSON.stringify(payload, null, 2));
    return { files: files.length, omitted: omitted.length, bytes: totalBytes, large: totalBytes >= LARGE_JSON_WARNING_BYTES };
  }

  async function exportWorkspaceForAiZip() {
    if (typeof JSZip === "undefined") throw new Error("JSZip is not available in this page.");
    const { files, omitted, totalBytes } = await collectWorkspaceTextFiles();
    const repo = $("repoSelect")?.value || "";
    const branch = $("branchSelect")?.value || "";
    const snapshot = await snapshotHash(files);
    const zip = new JSZip();
    const manifestFiles = [];

    for (const file of files) {
      const archivePath = `files/${file.path}`;
      zip.file(archivePath, file.content);
      manifestFiles.push({ path: file.path, sha256: file.sha256, archive_path: archivePath });
    }

    const manifest = {
      format: "riftcity-ai-workspace-zip",
      version: 1,
      workspace_format: FORMAT_WORKSPACE,
      workspace_version: WORKSPACE_VERSION,
      exported_at: new Date().toISOString(),
      repo: repo || null,
      branch: branch || null,
      snapshot_sha256: snapshot,
      file_count: files.length,
      text_bytes: totalBytes,
      files: manifestFiles,
      omitted,
      patch_contract: patchContract(repo, branch),
    };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    zip.file("README.txt", "RiftCity AI workspace ZIP. Read manifest.json, then files/<workspace path>. Binary and secret-like workspace files are intentionally omitted.\n");

    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    downloadBlob(`workspace-ai-export-${exportStamp()}.zip`, blob);
    return { files: files.length, omitted: omitted.length, bytes: totalBytes, zipBytes: blob.size };
  }

  function extractJsonText(text) {
    const raw = String(text || "").trim();
    if (!raw) throw new Error("Patch file is empty.");
    return raw;
  }

  function validateBaseHash(value, path) {
    if (value !== null && !/^[a-f0-9]{64}$/i.test(String(value))) {
      throw new Error(`Invalid base_sha256 for ${path}.`);
    }
    return value === null ? null : String(value).toLowerCase();
  }

  function normalizePatch(rawPayload) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      throw new Error("Patch must be one JSON object.");
    }
    if (rawPayload.format && rawPayload.format !== FORMAT_PATCH) {
      throw new Error(`Unsupported patch format: ${rawPayload.format}`);
    }
    const version = Number(rawPayload.version);
    if (version !== LEGACY_PATCH_VERSION && version !== PATCH_VERSION) {
      throw new Error(`Patch version must be ${LEGACY_PATCH_VERSION} or ${PATCH_VERSION}.`);
    }
    if (!Array.isArray(rawPayload.changes) || rawPayload.changes.length === 0) {
      throw new Error("Patch has no changes.");
    }
    if (rawPayload.changes.length > MAX_CHANGES) {
      throw new Error(`Patch exceeds the ${MAX_CHANGES}-file limit.`);
    }

    let totalBytes = 0;
    const usedPaths = new Map();
    const changes = rawPayload.changes.map((input, index) => {
      let action = String(input?.action || "").toLowerCase();
      if (action === "rename") action = "move";
      if (!["write", "delete", "move"].includes(action)) {
        throw new Error("Every change action must be write, delete, move, or rename.");
      }
      if (version === LEGACY_PATCH_VERSION && action === "move") {
        throw new Error("Move/rename actions require patch version 2.");
      }

      const path = normalizePath(input.path);
      if (usedPaths.has(path)) {
        throw new Error(`Patch path overlaps another operation: ${path}`);
      }
      usedPaths.set(path, index);

      const output = { action, path };
      if (Object.prototype.hasOwnProperty.call(input, "base_sha256")) {
        output.base_sha256 = validateBaseHash(input.base_sha256, path);
      }
      if (input.reason != null) output.reason = String(input.reason).slice(0, 500);
      if (input._review_confirmed_new === true) output._review_confirmed_new = true;

      if (action === "write") {
        if (typeof input.content !== "string") throw new Error(`Write change is missing text content: ${path}`);
        const bytes = encoder.encode(input.content).byteLength;
        if (bytes > MAX_FILE_BYTES) throw new Error(`${path} exceeds the ${MAX_FILE_BYTES}-byte per-file patch limit.`);
        totalBytes += bytes;
        output.content = input.content;
      } else if (action === "move") {
        const newPath = normalizePath(input.new_path);
        if (newPath === path) throw new Error(`Move source and destination are identical: ${path}`);
        if (usedPaths.has(newPath)) {
          throw new Error(`Move destination overlaps another patch operation: ${newPath}`);
        }
        usedPaths.set(newPath, index);
        output.new_path = newPath;
        if (Object.prototype.hasOwnProperty.call(input, "content")) {
          if (typeof input.content !== "string") throw new Error(`Move content must be text when supplied: ${path}`);
          const bytes = encoder.encode(input.content).byteLength;
          if (bytes > MAX_FILE_BYTES) throw new Error(`${path} exceeds the ${MAX_FILE_BYTES}-byte per-file patch limit.`);
          totalBytes += bytes;
          output.content = input.content;
        }
      }

      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`Patch exceeds the ${MAX_TOTAL_BYTES}-byte total text limit.`);
      }
      return output;
    });

    return {
      format: FORMAT_PATCH,
      version,
      title: String(rawPayload.title || rawPayload.commit_message || "AI patch").slice(0, 160),
      target_repo: rawPayload.target_repo ? String(rawPayload.target_repo).slice(0, 200) : null,
      target_branch: rawPayload.target_branch ? String(rawPayload.target_branch).slice(0, 200) : null,
      base_snapshot_sha256: rawPayload.base_snapshot_sha256 || null,
      created_at: rawPayload.created_at || new Date().toISOString(),
      changes,
    };
  }

  async function parsePatchText(text) {
    const raw = extractJsonText(text);
    let parsed;
    try {
      parsed = JSON.parse(raw);
      return normalizePatch(parsed);
    } catch (directError) {
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

  function basename(path = "") {
    return String(path).split("/").pop() || "";
  }

  function dirname(path = "") {
    const parts = String(path).split("/");
    parts.pop();
    return parts.join("/");
  }

  function versionlessBasename(path = "") {
    const base = basename(path).toLowerCase();
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    return stem.replace(/(?:[-_.](?:v)?\d+(?:[._-]\d+)*)$/i, "") + ext;
  }

  function versionNumber(path = "") {
    const base = basename(path);
    const match = base.match(/(?:^|[-_.])v?(\d+)(?=(?:\.[^.]+)?$)/i);
    return match ? Number(match[1]) || 0 : 0;
  }

  function levenshtein(a, b) {
    a = String(a || "");
    b = String(b || "");
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    let curr = new Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[b.length];
  }

  function findLikelyPath(requestedPath, candidates) {
    const requested = String(requestedPath || "");
    if (!requested || !candidates.length) return null;
    const lower = requested.toLowerCase();
    const exactCase = candidates.find((candidate) => candidate.toLowerCase() === lower);
    if (exactCase) return { path: exactCase, reason: "case-only path match", confidence: 1 };

    const reqBase = basename(lower);
    const reqDir = dirname(lower);
    const reqVersionless = versionlessBasename(lower);
    const versionMatches = candidates.filter((candidate) =>
      versionlessBasename(candidate) === reqVersionless && dirname(candidate.toLowerCase()) === reqDir
    );
    if (versionMatches.length) {
      versionMatches.sort((a, b) => versionNumber(b) - versionNumber(a) || a.length - b.length);
      return { path: versionMatches[0], reason: "versioned filename match", confidence: 0.98 };
    }

    const scored = candidates.map((candidate) => {
      const cLower = candidate.toLowerCase();
      const cBase = basename(cLower);
      const baseDistance = levenshtein(reqBase, cBase) / Math.max(1, reqBase.length, cBase.length);
      const pathDistance = levenshtein(lower, cLower) / Math.max(1, lower.length, cLower.length);
      let score = baseDistance * 0.72 + pathDistance * 0.28;
      if (dirname(cLower) === reqDir) score -= 0.08;
      return { path: candidate, score };
    }).sort((a, b) => a.score - b.score || a.path.length - b.path.length);

    const best = scored[0];
    const second = scored[1];
    if (!best || best.score > 0.22) return null;
    if (second && second.score - best.score < 0.035) return null;
    return { path: best.path, reason: "close filename/path match", confidence: Math.max(0.5, 1 - best.score) };
  }

  async function previewPatch(patch) {
    const files = typeof getAllWorkspaceFiles === "function" ? await getAllWorkspaceFiles() : [];
    const current = new Map(files.map((file) => [String(file.name), String(file.content ?? "")]));
    const paths = [...current.keys()];
    let snapshotMatches = null;
    if (patch.base_snapshot_sha256) {
      const snapshotFiles = [];
      for (const [path, content] of current) {
        if (!path || isSecretLikePath(path) || isBinaryWorkspaceValue(content)) continue;
        snapshotFiles.push({ path, sha256: await sha256(content) });
      }
      snapshotMatches = (await snapshotHash(snapshotFiles)) === patch.base_snapshot_sha256;
    }

    const rows = [];
    for (let index = 0; index < patch.changes.length; index++) {
      const change = patch.changes[index];
      const exists = current.has(change.path);
      const oldContent = exists ? current.get(change.path) : null;
      const oldHash = exists ? await sha256(oldContent) : null;
      const hasBase = Object.prototype.hasOwnProperty.call(change, "base_sha256");
      let conflict = false;
      let conflictReason = "";
      let suggested = null;
      let needsPathConfirmation = false;

      if (!exists && (change.action === "delete" || change.action === "move" || (hasBase && change.base_sha256 !== null))) {
        suggested = findLikelyPath(change.path, paths);
      }

      if (hasBase) {
        if (change.action === "write" && change.base_sha256 === null) {
          if (exists) {
            conflict = true;
            conflictReason = "Patch expected this file to be new, but it already exists.";
          }
        } else if (change.base_sha256 === null) {
          conflict = true;
          conflictReason = "Delete/move operations cannot safely use base_sha256:null because their source must already exist.";
        } else if (!exists) {
          conflict = true;
          conflictReason = "Patch expected this file to exist, but it is missing.";
        } else if (oldHash !== change.base_sha256) {
          conflict = true;
          conflictReason = "Local file changed since the workspace export used to build this patch.";
        }
      } else if (snapshotMatches === false) {
        conflict = true;
        conflictReason = "Workspace snapshot changed and this operation has no per-file base hash, so it cannot be verified safely.";
      }

      if (!conflict && !exists && change.action === "write" && !hasBase && !change._review_confirmed_new) {
        const likely = findLikelyPath(change.path, paths);
        if (likely) {
          suggested = likely;
          conflict = true;
          needsPathConfirmation = true;
          conflictReason = `Path does not exist, but a close workspace path was found: ${likely.path}`;
        }
      }

      if (!conflict && change.action === "delete" && !exists) {
        conflict = true;
        conflictReason = "Delete source does not exist.";
      }

      if (!conflict && change.action === "move") {
        if (!exists) {
          conflict = true;
          conflictReason = "Move source does not exist.";
        } else if (current.has(change.new_path)) {
          conflict = true;
          conflictReason = `Move destination already exists: ${change.new_path}`;
        }
      }

      let status = "unchanged";
      if (conflict) status = "conflict";
      else if (change.action === "delete") status = "delete";
      else if (change.action === "move") status = "move";
      else if (!exists) status = "create";
      else if (oldContent !== change.content) status = "modify";

      const newContent = change.action === "delete" ? null
        : change.action === "move" ? (typeof change.content === "string" ? change.content : oldContent)
        : change.content;

      rows.push({
        ...change,
        index,
        exists,
        oldContent,
        newContent,
        oldHash,
        hasBase,
        status,
        conflict,
        conflictReason,
        suggested,
        needsPathConfirmation,
      });
    }

    const counts = rows.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, { create: 0, modify: 0, delete: 0, move: 0, unchanged: 0, conflict: 0 });
    return { rows, counts, snapshotMatches };
  }

  function ensureReviewStyles() {
    if ($("aiPatchV2Styles")) return;
    const style = document.createElement("style");
    style.id = "aiPatchV2Styles";
    style.textContent = `
      .ai-patch-bulk{display:flex;gap:6px;flex-wrap:wrap;padding:4px 14px 6px;align-items:center}
      .ai-patch-select{width:18px;height:18px;flex:0 0 auto;accent-color:#4da3ff}
      .ai-patch-row.move{border-color:#6657a8}
      .ai-patch-chip.move{background:#3b3168;color:#e2dcff}
      .ai-patch-row-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
      .ai-patch-row-actions .btn{font-size:11px;padding:5px 8px}
      .ai-patch-suggestion{margin-top:7px;padding:7px;border:1px solid #765c1d;border-radius:8px;background:rgba(151,105,10,.12);font-size:12px;line-height:1.4}
      .ai-patch-diff{display:none;margin:8px 0 0;max-height:42dvh;overflow:auto;-webkit-overflow-scrolling:touch;white-space:pre;tab-size:4;padding:9px;border-radius:8px;background:#090c11;border:1px solid #2f3946;color:#d8dee9;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
      .ai-patch-diff.open{display:block}
      .ai-patch-snapshot-warning{margin:4px 14px 6px;padding:7px 9px;border-radius:8px;background:#2b210c;color:#f7d785;font-size:12px;line-height:1.35}
      body.theme-light .ai-patch-diff{background:#f5f7fa;color:#1f2937;border-color:#d9dee7}
      body.theme-light .ai-patch-suggestion{background:#fff8df;color:#604b14}
      @media(max-width:700px){.ai-patch-bulk>.btn{flex:1 1 110px}.ai-patch-diff{font-size:10px;max-height:35dvh}}
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    if ($("aiPatchModal")) return;
    ensureReviewStyles();
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
        <div id="aiPatchSnapshotWarning"></div>
        <div class="ai-patch-bulk">
          <button class="btn btn-sm btn-secondary" id="aiPatchSelectAllBtn" type="button">Select Safe Changes</button>
          <button class="btn btn-sm btn-secondary" id="aiPatchSelectNoneBtn" type="button">Deselect All</button>
          <span class="ai-patch-sub" id="aiPatchSelectedCount"></span>
        </div>
        <div class="ai-patch-list" id="aiPatchList"></div>
        <div class="ai-patch-actions">
          <button class="btn btn-danger" id="aiPatchDiscardBtn" type="button">Discard Patch</button>
          <button class="btn btn-secondary" id="aiPatchCloseFooterBtn" type="button">Close</button>
          <button class="btn btn-success" id="aiPatchApplyBtn" type="button">Apply Selected Changes</button>
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
    $("aiPatchSelectAllBtn").addEventListener("click", () => {
      document.querySelectorAll("#aiPatchList .ai-patch-select:not(:disabled)").forEach((box) => { box.checked = true; });
      refreshApplyButton();
    });
    $("aiPatchSelectNoneBtn").addEventListener("click", () => {
      document.querySelectorAll("#aiPatchList .ai-patch-select").forEach((box) => { box.checked = false; });
      refreshApplyButton();
    });
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
    return ({ create: "CREATE", modify: "MODIFY", delete: "DELETE", move: "MOVE", unchanged: "NO CHANGE", conflict: "CONFLICT" })[status] || status.toUpperCase();
  }

  function selectedIndexesFromUi() {
    return new Set([...document.querySelectorAll("#aiPatchList .ai-patch-select:checked")]
      .map((box) => Number(box.dataset.index))
      .filter(Number.isInteger));
  }

  function refreshApplyButton() {
    const applyBtn = $("aiPatchApplyBtn");
    if (!applyBtn || !currentPreview) return;
    const selected = selectedIndexesFromUi();
    const selectedRows = currentPreview.rows.filter((row) => selected.has(row.index) && ACTIONABLE.has(row.status) && !row.conflict);
    applyBtn.disabled = selectedRows.length === 0;
    applyBtn.textContent = selectedRows.length ? `Apply Selected (${selectedRows.length})` : "Select Changes to Apply";
    const count = $("aiPatchSelectedCount");
    if (count) count.textContent = `${selectedRows.length} safe change${selectedRows.length === 1 ? "" : "s"} selected`;
  }

  function lineDiffOperations(oldText, newText) {
    const oldLines = String(oldText ?? "").split("\n");
    const newLines = String(newText ?? "").split("\n");
    const ops = [];
    let i = 0;
    let j = 0;
    const lookahead = 50;

    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        ops.push({ type: " ", text: oldLines[i] });
        i += 1;
        j += 1;
        continue;
      }
      if (i >= oldLines.length) {
        ops.push({ type: "+", text: newLines[j++] });
        continue;
      }
      if (j >= newLines.length) {
        ops.push({ type: "-", text: oldLines[i++] });
        continue;
      }

      let best = null;
      const maxOld = Math.min(oldLines.length - i - 1, lookahead);
      const maxNew = Math.min(newLines.length - j - 1, lookahead);
      for (let a = 0; a <= maxOld; a++) {
        for (let b = 0; b <= maxNew; b++) {
          if (a === 0 && b === 0) continue;
          if (oldLines[i + a] === newLines[j + b]) {
            const cost = a + b;
            if (!best || cost < best.cost || (cost === best.cost && Math.max(a, b) < Math.max(best.a, best.b))) {
              best = { a, b, cost };
            }
          }
        }
      }
      if (!best) {
        ops.push({ type: "-", text: oldLines[i++] });
        ops.push({ type: "+", text: newLines[j++] });
        continue;
      }
      for (let a = 0; a < best.a; a++) ops.push({ type: "-", text: oldLines[i++] });
      for (let b = 0; b < best.b; b++) ops.push({ type: "+", text: newLines[j++] });
    }
    return ops;
  }

  function compactUnchangedRuns(ops) {
    const out = [];
    let i = 0;
    while (i < ops.length) {
      if (ops[i].type !== " ") {
        out.push(ops[i++]);
        continue;
      }
      let end = i;
      while (end < ops.length && ops[end].type === " ") end += 1;
      const run = ops.slice(i, end);
      if (run.length <= 10) out.push(...run);
      else {
        out.push(...run.slice(0, 4));
        out.push({ type: "@", text: `... ${run.length - 8} unchanged line${run.length - 8 === 1 ? "" : "s"} ...` });
        out.push(...run.slice(-4));
      }
      i = end;
    }
    return out;
  }

  function buildUnifiedDiff(row) {
    const oldPath = row.action === "write" && row.status === "create" ? "/dev/null" : row.path;
    const newPath = row.action === "delete" ? "/dev/null" : (row.action === "move" ? row.new_path : row.path);
    const header = [`--- ${oldPath}`, `+++ ${newPath}`];
    if (row.action === "move" && row.oldContent === row.newContent) {
      return [...header, `rename from ${row.path}`, `rename to ${row.new_path}`, "(content unchanged)"].join("\n");
    }
    const ops = compactUnchangedRuns(lineDiffOperations(row.oldContent ?? "", row.newContent ?? ""));
    return [...header, ...ops.map((op) => op.type === "@" ? `@@ ${op.text}` : `${op.type}${op.text}`)].join("\n");
  }

  async function useSuggestedPath(index, path) {
    const patch = await getPendingPatch();
    if (!patch?.changes?.[index]) return;
    patch.changes[index].path = normalizePath(path);
    delete patch.changes[index]._review_confirmed_new;
    const normalized = normalizePatch(patch);
    await setPendingPatch(normalized);
    updatePendingButton(normalized);
    await renderReview(normalized);
  }

  async function confirmNewPath(index) {
    const patch = await getPendingPatch();
    if (!patch?.changes?.[index]) return;
    patch.changes[index]._review_confirmed_new = true;
    await setPendingPatch(patch);
    await renderReview(patch);
  }

  async function renderReview(patch) {
    ensureModal();
    const preview = await previewPatch(patch);
    currentPreview = preview;
    $("aiPatchTitle").textContent = patch.title || "AI Patch Review";
    $("aiPatchSubtitle").textContent = `${patch.changes.length} requested file operation${patch.changes.length === 1 ? "" : "s"} · patch v${patch.version}`;
    $("aiPatchSummary").innerHTML = [
      ["create", preview.counts.create], ["modify", preview.counts.modify], ["move", preview.counts.move], ["delete", preview.counts.delete],
      ["unchanged", preview.counts.unchanged], ["conflict", preview.counts.conflict]
    ].filter(([, count]) => count).map(([key, count]) => `<span class="ai-patch-chip ${key}">${count} ${esc(key)}</span>`).join("") || '<span class="ai-patch-chip unchanged">No changes</span>';

    const snapshotWarning = $("aiPatchSnapshotWarning");
    if (snapshotWarning) {
      snapshotWarning.innerHTML = preview.snapshotMatches === false
        ? '<div class="ai-patch-snapshot-warning">Workspace snapshot differs from the patch base. Safe per-file hashes are still checked individually, so clean changes can be cherry-picked while conflicts stay blocked.</div>'
        : "";
    }

    $("aiPatchList").innerHTML = preview.rows.map((row) => {
      const canSelect = ACTIONABLE.has(row.status) && !row.conflict;
      const pathText = row.action === "move" ? `${row.path} → ${row.new_path}` : row.path;
      const suggestion = row.suggested ? `
        <div class="ai-patch-suggestion">
          Did you mean <code>${esc(row.suggested.path)}</code>? <span class="ai-patch-sub">(${esc(row.suggested.reason)})</span>
          <div class="ai-patch-row-actions">
            <button class="btn btn-sm btn-secondary ai-use-suggestion" type="button" data-index="${row.index}" data-path="${esc(row.suggested.path)}">Use Suggested Path</button>
            ${row.needsPathConfirmation ? `<button class="btn btn-sm btn-secondary ai-confirm-new" type="button" data-index="${row.index}">Create New Anyway</button>` : ""}
          </div>
        </div>` : "";
      const hasDiff = row.status !== "unchanged" || row.conflict;
      return `
        <div class="ai-patch-row ${esc(row.status)}">
          <div class="ai-patch-row-top">
            <input class="ai-patch-select" type="checkbox" data-index="${row.index}" ${canSelect ? "checked" : "disabled"} aria-label="Select ${esc(pathText)}">
            <span class="ai-patch-status">${esc(statusLabel(row.status))}</span>
            <code>${esc(pathText)}</code>
          </div>
          ${row.reason ? `<div class="ai-patch-reason">${esc(row.reason)}</div>` : ""}
          ${row.conflictReason ? `<div class="ai-patch-conflict">${esc(row.conflictReason)}</div>` : ""}
          ${!row.hasBase && row.status !== "unchanged" ? '<div class="ai-patch-unverified">No base hash supplied — safety falls back to the workspace snapshot.</div>' : ""}
          ${suggestion}
          ${hasDiff ? `<div class="ai-patch-row-actions"><button class="btn btn-sm btn-secondary ai-toggle-diff" type="button" data-index="${row.index}">View Diff</button></div><pre class="ai-patch-diff" id="aiPatchDiff-${row.index}"></pre>` : ""}
        </div>`;
    }).join("");

    $("aiPatchList").querySelectorAll(".ai-patch-select").forEach((box) => box.addEventListener("change", refreshApplyButton));
    $("aiPatchList").querySelectorAll(".ai-toggle-diff").forEach((button) => button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      const row = currentPreview?.rows.find((candidate) => candidate.index === index);
      const pre = $(`aiPatchDiff-${index}`);
      if (!row || !pre) return;
      const opening = !pre.classList.contains("open");
      if (opening && !pre.dataset.ready) {
        pre.textContent = buildUnifiedDiff(row);
        pre.dataset.ready = "1";
      }
      pre.classList.toggle("open", opening);
      button.textContent = opening ? "Hide Diff" : "View Diff";
    }));
    $("aiPatchList").querySelectorAll(".ai-use-suggestion").forEach((button) => button.addEventListener("click", () => {
      useSuggestedPath(Number(button.dataset.index), button.dataset.path).catch((error) => alert(error.message || error));
    }));
    $("aiPatchList").querySelectorAll(".ai-confirm-new").forEach((button) => button.addEventListener("click", () => {
      confirmNewPath(Number(button.dataset.index)).catch((error) => alert(error.message || error));
    }));

    refreshApplyButton();
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

  async function applyPatchTransaction(preview, selectedIndexes) {
    const rows = preview.rows.filter((row) => selectedIndexes.has(row.index) && ACTIONABLE.has(row.status) && !row.conflict);
    const database = await getDatabase();
    const stores = database.objectStoreNames.contains("folders") ? ["files", "folders"] : ["files"];
    await new Promise((resolve, reject) => {
      const tx = database.transaction(stores, "readwrite");
      const fileStore = tx.objectStore("files");
      const folderStore = stores.includes("folders") ? tx.objectStore("folders") : null;
      const folderSet = new Set();

      for (const row of rows) {
        if (row.status === "create" || row.status === "modify") {
          fileStore.put({ name: row.path, content: row.content });
          for (const folder of parentFolders(row.path)) folderSet.add(folder);
        } else if (row.status === "delete") {
          fileStore.delete(row.path);
        } else if (row.status === "move") {
          fileStore.delete(row.path);
          fileStore.put({ name: row.new_path, content: row.newContent });
          for (const folder of parentFolders(row.new_path)) folderSet.add(folder);
        }
      }
      if (folderStore) for (const folder of folderSet) folderStore.put({ path: folder });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Patch transaction failed."));
      tx.onabort = () => reject(tx.error || new Error("Patch transaction was aborted."));
    });
    return rows;
  }

  function emitPathMoved(oldPath, newPath) {
    if (typeof updateOpenPathAfterMove === "function") {
      updateOpenPathAfterMove(oldPath, newPath, false);
      return;
    }
    const editor = $("editor");
    if (editor?.dataset?.filename === oldPath) editor.dataset.filename = newPath;
    try { window.dispatchEvent(new CustomEvent("workspace:path-moved", { detail: { oldPath, newPath, isFolder: false } })); } catch (_) {}
  }

  function emitFileDeleted(path) {
    try { window.dispatchEvent(new CustomEvent("workspace:file-deleted", { detail: { path } })); } catch (_) {}
  }

  async function applyPendingPatch() {
    const button = $("aiPatchApplyBtn");
    if (button?.disabled) return;
    const patch = await getPendingPatch();
    if (!patch) return alert("Pending patch is missing.");
    const selectedRequested = selectedIndexesFromUi();
    if (!selectedRequested.size) return alert("Select at least one safe change first.");

    try {
      await saveDirtyEditorIfNeeded();
      await assertPatchTargetMatchesWorkspace(patch);
    } catch (error) {
      return alert(error.message || error);
    }

    const preview = await previewPatch(patch);
    const selectedSafe = new Set(preview.rows
      .filter((row) => selectedRequested.has(row.index) && ACTIONABLE.has(row.status) && !row.conflict)
      .map((row) => row.index));
    if (!selectedSafe.size) {
      await renderReview(patch);
      return alert("The selected changes are no longer safe to apply. Review the updated conflicts first.");
    }
    if (selectedSafe.size !== selectedRequested.size) {
      await renderReview(patch);
      return alert("One or more selected changes became conflicts. They were blocked; review the patch again.");
    }
    if (!confirm(`Apply ${selectedSafe.size} selected change(s) to the local workspace?\n\nGitHub will NOT be pushed automatically.`)) return;

    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = "Applying…";
    try {
      const activePathBefore = $("editor")?.dataset?.filename || "";
      const appliedRows = await applyPatchTransaction(preview, selectedSafe);

      for (const row of appliedRows) {
        if (typeof workspaceHashCache !== "undefined" && workspaceHashCache?.delete) {
          workspaceHashCache.delete(row.path);
          if (row.new_path) workspaceHashCache.delete(row.new_path);
        }
        if (row.status === "move") emitPathMoved(row.path, row.new_path);
        if (row.status === "delete") emitFileDeleted(row.path);
      }

      let activePathAfter = activePathBefore;
      const movedActive = appliedRows.find((row) => row.status === "move" && row.path === activePathBefore);
      if (movedActive) activePathAfter = movedActive.new_path;
      const deletedActive = appliedRows.some((row) => row.status === "delete" && row.path === activePathBefore);
      const changedActive = appliedRows.some((row) =>
        (row.status === "modify" && row.path === activePathBefore) || (row.status === "move" && row.path === activePathBefore)
      );

      if (deletedActive && typeof closeCurrentFile === "function") {
        closeCurrentFile();
      } else if (changedActive && activePathAfter && typeof openFile === "function") {
        await openFile(activePathAfter);
      }

      if (typeof loadFiles === "function") await loadFiles();
      if (typeof scheduleGitSyncStatusUpdate === "function") scheduleGitSyncStatusUpdate();

      const remainingChanges = patch.changes.filter((_, index) => !selectedSafe.has(index));
      if (remainingChanges.length) {
        const remainingPatch = { ...patch, changes: remainingChanges, base_snapshot_sha256: await currentWorkspaceSnapshotHash() };
        await setPendingPatch(remainingPatch);
        updatePendingButton(remainingPatch);
        await renderReview(remainingPatch);
        alert(`Applied ${appliedRows.length} selected change(s). ${remainingChanges.length} patch operation(s) remain for review.`);
      } else {
        await clearPendingPatch();
        updatePendingButton(null);
        closeReview();
        alert(`Applied ${appliedRows.length} selected change(s) to the local workspace.\n\nReview anything you want, then use the normal Push Changes button when you're ready.`);
      }
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
    await saveDirtyEditorIfNeeded();
    await assertPatchTargetMatchesWorkspace(patch);
    await setPendingPatch(patch);
    updatePendingButton(patch);
    await renderReview(patch);
  }

  function ensureZipExportButton() {
    if ($("exportAiWorkspaceZipBtn") || typeof JSZip === "undefined") return;
    const jsonButton = $("exportAiWorkspaceBtn");
    if (!jsonButton?.parentNode) return;
    const button = document.createElement("button");
    button.id = "exportAiWorkspaceZipBtn";
    button.type = "button";
    button.className = jsonButton.className;
    button.textContent = "🤖 AI ZIP";
    button.title = "Export a compressed AI workspace package for large repositories";
    jsonButton.insertAdjacentElement("afterend", button);
    button.addEventListener("click", async () => {
      const old = button.textContent;
      button.disabled = true;
      button.textContent = "Zipping…";
      try {
        const result = await exportWorkspaceForAiZip();
        const omitted = result.omitted ? ` ${result.omitted} binary/secret file(s) were intentionally omitted.` : "";
        alert(`Compressed AI workspace created with ${result.files} text file(s).${omitted}\n\nSend the ZIP to ChatGPT when you want a patch.`);
      } catch (error) {
        console.error(error);
        alert("AI workspace ZIP export failed: " + (error.message || error));
      } finally {
        button.disabled = false;
        button.textContent = old;
      }
    });
  }

  function bindUi() {
    ensureModal();
    ensureZipExportButton();
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
        const large = result.large ? " This is a large JSON export; the AI ZIP option will usually be easier on mobile memory." : "";
        alert(`AI workspace export created with ${result.files} text file(s).${omitted}${large}\n\nSend that file to ChatGPT when you want a patch.`);
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
