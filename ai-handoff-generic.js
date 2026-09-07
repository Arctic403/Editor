/* Generic Mobile Workspace AI handoff adapter.
   Keeps the proven v2 review/apply engine in ai-handoff.js, while exposing a
   repository-agnostic export/return protocol to external AIs.
*/
(() => {
  "use strict";

  const FORMAT_WORKSPACE = "mobile-workspace-ai-workspace";
  const FORMAT_WORKSPACE_ZIP = "mobile-workspace-ai-workspace-zip";
  const FORMAT_PATCH = "mobile-workspace-ai-patch";
  const LEGACY_PATCH_FORMAT = "riftcity-ai-patch";
  const WORKSPACE_VERSION = 1;
  const PATCH_VERSION = 2;
  const MAX_CHANGES = 100;
  const MAX_FILE_BYTES = 2_000_000;
  const MAX_TOTAL_BYTES = 10_000_000;
  const LARGE_JSON_WARNING_BYTES = 2_500_000;
  const encoder = new TextEncoder();
  const $ = (id) => document.getElementById(id);

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
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(text)));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function snapshotHash(files) {
    const rows = [];
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push(`${file.path}\0${file.sha256}`);
    }
    return sha256(rows.join("\n"));
  }

  function exportStamp() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
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

  function downloadJson(filename, payload) {
    const text = JSON.stringify(payload, null, 2);
    downloadBlob(filename, new Blob([text], { type: "application/json;charset=utf-8" }));
  }

  async function saveDirtyEditorIfNeeded() {
    const editor = $("editor");
    const path = editor?.dataset?.filename || "";
    if (!path || typeof saveFileToDb !== "function") return;
    if (typeof isDirty !== "undefined" && !isDirty) return;
    await saveFileToDb(path, editor.value);
    if (typeof updateDirtyIndicator === "function") updateDirtyIndicator(false);
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

  function patchContract(repo, branch) {
    return {
      format: FORMAT_PATCH,
      version: PATCH_VERSION,
      accepted_legacy_format: LEGACY_PATCH_FORMAT,
      actions: ["write", "delete", "move"],
      rename_alias: true,
      target_repo: repo || null,
      target_branch: branch || null,
      max_changes: MAX_CHANGES,
      max_file_bytes: MAX_FILE_BYTES,
      max_total_text_bytes: MAX_TOTAL_BYTES,
      return_file: {
        type: "JSON",
        extension: ".json",
        mime_type: "application/json",
        encoding: "UTF-8",
        raw_json_only: true,
        markdown_fences_allowed: false,
        suggested_filename: "workspace-ai-patch.json"
      },
      note: "Return one raw UTF-8 JSON patch file. Copy target_repo, target_branch, and base_snapshot_sha256 exactly from this export. Existing-file write/delete/move actions use that file's exported sha256 as base_sha256. New write actions use base_sha256:null."
    };
  }

  function handoffRules(repo, branch, snapshot) {
    return {
      name: "Mobile Workspace AI Handoff",
      scope: "repository-agnostic",
      current_workspace: {
        repo: repo || null,
        branch: branch || null,
        snapshot_sha256: snapshot
      },
      return_exactly: {
        file_type: "JSON",
        extension: ".json",
        mime_type: "application/json",
        encoding: "UTF-8",
        suggested_filename: "workspace-ai-patch.json",
        top_level_format: FORMAT_PATCH,
        version: PATCH_VERSION,
        raw_json_only: true,
        no_markdown_code_fence: true,
        no_leading_or_trailing_commentary_inside_file: true
      },
      rules: [
        "Treat this exported workspace as the source of truth for the requested code changes.",
        "This protocol is not tied to RiftCity or any project name. Work only against the repo and branch named in this export.",
        "Return a raw UTF-8 .json file, not a ZIP, Markdown document, code block, prose response, or renamed source archive unless the user explicitly asks for something else.",
        `The patch top-level format must be '${FORMAT_PATCH}' and version must be ${PATCH_VERSION}.`,
        "Copy target_repo exactly from repo, target_branch exactly from branch, and base_snapshot_sha256 exactly from snapshot_sha256.",
        "Use a top-level changes array. Each change action must be write, delete, or move. rename may be used only as an alias for move.",
        "For an existing file, copy its exported sha256 into base_sha256. Do this for write, delete, and move actions.",
        "For a genuinely new file created with write, set base_sha256 to null.",
        "A write action must include the complete final text of that file in content, not a diff fragment.",
        "A move action uses path as the existing source and new_path as the destination. It may include content when the file is also modified during the move.",
        "Do not invent paths, repo names, branch names, or base hashes. Preserve exact path casing from the export.",
        "Do not include secret-like files or binary/data-URL files that the export intentionally omitted.",
        `Keep the patch within ${MAX_CHANGES} changes, ${MAX_FILE_BYTES} bytes per text file, and ${MAX_TOTAL_BYTES} total text bytes.`,
        "The editor will re-check hashes and block stale or conflicting operations during review; do not try to bypass those checks.",
        "After import, the user reviews/cherry-picks changes locally. GitHub is not pushed automatically."
      ],
      patch_shape: {
        format: FORMAT_PATCH,
        version: PATCH_VERSION,
        title: "Short description of the patch",
        target_repo: repo || "<copy repo from export>",
        target_branch: branch || "<copy branch from export>",
        base_snapshot_sha256: snapshot,
        created_at: "<ISO-8601 timestamp>",
        changes: [
          {
            action: "write",
            path: "path/to/file.ext",
            base_sha256: "<exported file sha256, or null only when creating a new file>",
            content: "<complete final file text>"
          }
        ]
      }
    };
  }

  async function buildWorkspacePayload() {
    const { files, omitted, totalBytes } = await collectWorkspaceTextFiles();
    const repo = $("repoSelect")?.value || "";
    const branch = $("branchSelect")?.value || "";
    const snapshot = await snapshotHash(files);
    return {
      payload: {
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
        ai_handoff_rules: handoffRules(repo, branch, snapshot)
      },
      files,
      omitted,
      totalBytes,
      repo,
      branch,
      snapshot
    };
  }

  async function exportWorkspaceJson() {
    const built = await buildWorkspacePayload();
    downloadJson(`workspace-ai-export-${exportStamp()}.json`, built.payload);
    return {
      files: built.files.length,
      omitted: built.omitted.length,
      bytes: built.totalBytes,
      large: built.totalBytes >= LARGE_JSON_WARNING_BYTES,
      repo: built.repo,
      branch: built.branch
    };
  }

  async function exportWorkspaceZip() {
    if (typeof JSZip === "undefined") throw new Error("JSZip is not available in this page.");
    const built = await buildWorkspacePayload();
    const zip = new JSZip();
    const manifestFiles = [];

    for (const file of built.files) {
      const archivePath = `files/${file.path}`;
      zip.file(archivePath, file.content);
      manifestFiles.push({ path: file.path, sha256: file.sha256, archive_path: archivePath });
    }

    const manifest = {
      format: FORMAT_WORKSPACE_ZIP,
      version: 1,
      workspace_format: FORMAT_WORKSPACE,
      workspace_version: WORKSPACE_VERSION,
      exported_at: built.payload.exported_at,
      repo: built.repo || null,
      branch: built.branch || null,
      snapshot_sha256: built.snapshot,
      file_count: built.files.length,
      text_bytes: built.totalBytes,
      files: manifestFiles,
      omitted: built.omitted,
      patch_contract: patchContract(built.repo, built.branch),
      ai_handoff_rules: handoffRules(built.repo, built.branch, built.snapshot)
    };

    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    zip.file("AI_HANDOFF_RULES.json", JSON.stringify(manifest.ai_handoff_rules, null, 2));
    zip.file(
      "README.txt",
      "Mobile Workspace AI handoff package. This package is repository-agnostic. Read manifest.json and AI_HANDOFF_RULES.json before editing. Source text files are under files/<workspace path>. Return the finished patch as one raw UTF-8 .json file using the format and rules in the manifest. Binary and secret-like workspace files are intentionally omitted.\n"
    );

    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    downloadBlob(`workspace-ai-export-${exportStamp()}.zip`, blob);
    return {
      files: built.files.length,
      omitted: built.omitted.length,
      bytes: built.totalBytes,
      zipBytes: blob.size,
      repo: built.repo,
      branch: built.branch
    };
  }

  function currentWorkspaceLabel(repo, branch) {
    if (repo && branch) return `${repo} @ ${branch}`;
    if (repo) return repo;
    return "the current local workspace";
  }

  async function handleJsonExport(button) {
    const old = button.textContent;
    button.disabled = true;
    button.textContent = "Exporting…";
    try {
      const result = await exportWorkspaceJson();
      const omitted = result.omitted ? ` ${result.omitted} binary/secret file(s) were intentionally omitted.` : "";
      const large = result.large ? " This is a large JSON export; AI ZIP may be easier on mobile memory." : "";
      alert(`AI workspace export created for ${currentWorkspaceLabel(result.repo, result.branch)} with ${result.files} text file(s).${omitted}${large}\n\nThe export now contains the exact handoff rules and required return .json format.`);
    } catch (error) {
      console.error(error);
      alert("AI workspace export failed: " + (error.message || error));
    } finally {
      button.disabled = false;
      button.textContent = old;
    }
  }

  async function handleZipExport(button) {
    const old = button.textContent;
    button.disabled = true;
    button.textContent = "Zipping…";
    try {
      const result = await exportWorkspaceZip();
      const omitted = result.omitted ? ` ${result.omitted} binary/secret file(s) were intentionally omitted.` : "";
      alert(`Compressed AI workspace created for ${currentWorkspaceLabel(result.repo, result.branch)} with ${result.files} text file(s).${omitted}\n\nThe ZIP includes manifest.json plus AI_HANDOFF_RULES.json. The AI should return one raw .json patch file.`);
    } catch (error) {
      console.error(error);
      alert("AI workspace ZIP export failed: " + (error.message || error));
    } finally {
      button.disabled = false;
      button.textContent = old;
    }
  }

  function installExportInterceptors() {
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("#exportAiWorkspaceBtn, #exportAiWorkspaceZipBtn") : null;
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (target.id === "exportAiWorkspaceZipBtn") handleZipExport(target);
      else handleJsonExport(target);
    }, true);
  }

  function translatedPatchFile(file, parsed) {
    const translated = { ...parsed, format: LEGACY_PATCH_FORMAT };
    return new File([JSON.stringify(translated, null, 2)], file.name || "workspace-ai-patch.json", {
      type: "application/json",
      lastModified: Date.now()
    });
  }

  function setInputFile(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
  }

  function installImportAlias() {
    const input = $("aiPatchInput");
    if (!input) return;

    input.addEventListener("change", async (event) => {
      if (input.dataset.genericHandoffPassThrough === "1") {
        delete input.dataset.genericHandoffPassThrough;
        return;
      }

      const file = input.files?.[0];
      if (!file) return;

      event.stopImmediatePropagation();
      try {
        const raw = (await file.text()).trim();
        const parsed = JSON.parse(raw);
        if (parsed?.format === FORMAT_PATCH) {
          setInputFile(input, translatedPatchFile(file, parsed));
        } else if (parsed?.format !== LEGACY_PATCH_FORMAT && parsed?.format) {
          alert(`Patch import failed: unsupported patch format '${parsed.format}'. Expected '${FORMAT_PATCH}'.`);
          input.value = "";
          return;
        }
        input.dataset.genericHandoffPassThrough = "1";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (error) {
        // Preserve the core parser's existing diagnostics/fenced-JSON fallback for malformed or legacy text.
        input.dataset.genericHandoffPassThrough = "1";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, true);
  }

  function polishUi() {
    const jsonButton = $("exportAiWorkspaceBtn");
    if (jsonButton) jsonButton.title = "Export the current repo/branch with self-contained AI handoff rules";
    const importButton = $("importAiPatchBtn");
    if (importButton) importButton.title = `Import ${FORMAT_PATCH} JSON for the currently selected repo/branch`;
    const zipButton = $("exportAiWorkspaceZipBtn");
    if (zipButton) zipButton.title = "Export the current repo/branch as an AI ZIP with handoff rules";
  }

  function init() {
    installExportInterceptors();
    installImportAlias();
    polishUi();
    // Core creates the AI ZIP button during its own DOMContentLoaded init; refresh once more next tick.
    setTimeout(polishUi, 0);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
