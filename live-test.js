/* RiftCity Cloudflare Live Test
   Deploys the CURRENT LOCAL Editor workspace to an isolated preview Worker.
   GitHub is never written by this feature.
*/
(() => {
  "use strict";

  const TARGET_REPO = "Arctic403/RiftCityV1";
  const PREVIEW_WORKER = "riftcity-live-test";
  const ACCOUNT_KEY = "riftcity_live_test_cf_account_v1";
  const TOKEN_KEY = "riftcity_live_test_cf_token_session_v1";
  const LAST_URL_KEY = "riftcity_live_test_last_url_v1";
  const MAX_FILES = 5000;
  const MAX_TEXT_CHARS = 75_000_000;

  const $ = (id) => document.getElementById(id);
  const esc = (value = "") => String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

  function isSecretPath(path) {
    const normalized = String(path || "").replace(/\\/g, "/");
    const base = normalized.split("/").pop() || "";
    return /^(?:\.env)(?:\..*)?$/i.test(base)
      || /^(?:\.npmrc|\.pypirc|id_rsa|id_ed25519)$/i.test(base)
      || /\.(?:pem|key|p12|pfx)$/i.test(base);
  }

  async function saveDirtyEditor() {
    const editor = $("editor");
    const path = editor?.dataset?.filename || "";
    if (!path || typeof saveFileToDb !== "function") return;
    if (typeof isDirty !== "undefined" && !isDirty) return;
    await saveFileToDb(path, editor.value);
    if (typeof updateDirtyIndicator === "function") updateDirtyIndicator(false);
  }

  async function collectWorkspace() {
    if (typeof getAllWorkspaceFiles !== "function") {
      throw new Error("Workspace file API is unavailable.");
    }
    await saveDirtyEditor();
    const source = await getAllWorkspaceFiles();
    if (source.length > MAX_FILES) throw new Error(`Live Test supports up to ${MAX_FILES} workspace files.`);

    let chars = 0;
    const files = [];
    for (const file of source) {
      const path = String(file?.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!path || path.startsWith(".git/") || path.startsWith("node_modules/") || isSecretPath(path)) continue;
      const content = typeof file.content === "string" ? file.content : String(file.content ?? "");
      chars += content.length;
      if (chars > MAX_TEXT_CHARS) {
        throw new Error("Workspace is too large for one Live Test upload. Remove generated/dependency files and try again.");
      }
      files.push({ path, content });
    }
    return files;
  }

  function ensureStyles() {
    if ($("liveTestStyles")) return;
    const style = document.createElement("style");
    style.id = "liveTestStyles";
    style.textContent = `
      .live-test-overlay{position:fixed;inset:0;z-index:200000;background:rgba(2,6,12,.78);display:flex;align-items:center;justify-content:center;padding:max(12px,env(safe-area-inset-top)) 12px max(12px,env(safe-area-inset-bottom));box-sizing:border-box}
      .live-test-overlay.hidden{display:none}
      .live-test-dialog{width:min(680px,100%);max-height:94dvh;overflow:auto;-webkit-overflow-scrolling:touch;background:#10161f;color:#eaf0f7;border:1px solid #334153;border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.45);padding:16px;box-sizing:border-box}
      .live-test-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:12px}
      .live-test-head h2{font-size:18px;margin:0 0 3px}.live-test-head p{margin:0;color:#9fb0c2;font-size:12px}
      .live-test-close{border:1px solid #435064;background:#192331;color:#fff;border-radius:9px;min-width:38px;height:38px;font-size:18px}
      .live-test-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.live-test-field{display:flex;flex-direction:column;gap:5px}
      .live-test-field.full{grid-column:1/-1}.live-test-field label{font-size:11px;font-weight:700;color:#9fb0c2;text-transform:uppercase;letter-spacing:.05em}
      .live-test-field input{width:100%;box-sizing:border-box;border:1px solid #34445a;border-radius:9px;background:#0a0f16;color:#fff;padding:10px 11px;font:14px system-ui}
      .live-test-note{margin:12px 0;padding:10px;border:1px solid #294b6b;background:#0d2234;border-radius:10px;font-size:12px;line-height:1.45;color:#c9e6ff}
      .live-test-status{margin-top:12px;min-height:64px;white-space:pre-wrap;border-radius:10px;border:1px solid #2d3847;background:#090d13;padding:10px;color:#c8d4df;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
      .live-test-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.live-test-actions button{flex:1 1 135px;border:0;border-radius:10px;padding:11px 12px;font-weight:800}
      .live-test-deploy{background:#22c55e;color:#07150b}.live-test-open{background:#2d78ff;color:white}.live-test-stop{background:#63252b;color:#ffd8dc}.live-test-secondary{background:#283443;color:#e9f1f9}
      .live-test-actions button:disabled{opacity:.45}
      .live-test-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:#17331f;color:#9bf5b1;padding:4px 8px;font-size:11px;font-weight:800}
      body.theme-light .live-test-dialog{background:#fff;color:#18202a}.theme-light .live-test-field input{background:#fff;color:#111}.theme-light .live-test-status{background:#f5f7fa;color:#27313d}
      @media(max-width:600px){.live-test-grid{grid-template-columns:1fr}.live-test-field.full{grid-column:auto}.live-test-dialog{padding:13px;border-radius:13px}}
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    ensureStyles();
    if ($("liveTestModal")) return;
    const overlay = document.createElement("div");
    overlay.id = "liveTestModal";
    overlay.className = "live-test-overlay hidden";
    overlay.innerHTML = `
      <section class="live-test-dialog" role="dialog" aria-modal="true" aria-labelledby="liveTestTitle">
        <div class="live-test-head">
          <div>
            <h2 id="liveTestTitle">🧪 RiftCity Live Test</h2>
            <p>Deploy this browser workspace to a separate Cloudflare preview. GitHub stays untouched.</p>
          </div>
          <button class="live-test-close" id="liveTestClose" type="button" aria-label="Close">×</button>
        </div>
        <div class="live-test-grid">
          <div class="live-test-field">
            <label>Target</label>
            <input id="liveTestTarget" type="text" value="${TARGET_REPO}" readonly>
          </div>
          <div class="live-test-field">
            <label>Preview Worker</label>
            <input id="liveTestWorker" type="text" value="${PREVIEW_WORKER}" readonly>
          </div>
          <div class="live-test-field full">
            <label>Cloudflare Account ID</label>
            <input id="liveTestAccount" type="text" autocomplete="off" placeholder="32-character Cloudflare account ID">
          </div>
          <div class="live-test-field full">
            <label>Cloudflare API Token</label>
            <input id="liveTestToken" type="password" autocomplete="off" placeholder="Workers Scripts + D1 + R2 edit token">
          </div>
        </div>
        <div class="live-test-note">
          Preview data is isolated automatically: <b>riftcity-live-test-db</b> (D1) and
          <b>riftcity-live-test-assets</b> (R2). The API token is kept only in this browser tab.
          The preview deploy never commits or pushes GitHub.
        </div>
        <div class="live-test-status" id="liveTestStatus">Ready. Pull RiftCity, apply/edit locally, then deploy the current workspace.</div>
        <div class="live-test-actions">
          <button class="live-test-deploy" id="liveTestDeploy" type="button">▶ DEPLOY LIVE TEST</button>
          <button class="live-test-open" id="liveTestOpen" type="button">OPEN PREVIEW</button>
          <button class="live-test-secondary" id="liveTestRefresh" type="button">CHECK SETUP</button>
          <button class="live-test-stop" id="liveTestStop" type="button">STOP PREVIEW</button>
        </div>
      </section>`;
    document.body.appendChild(overlay);

    $("liveTestClose").addEventListener("click", closeModal);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) closeModal(); });
    $("liveTestAccount").addEventListener("change", () => {
      try { localStorage.setItem(ACCOUNT_KEY, $("liveTestAccount").value.trim()); } catch (_) {}
    });
    $("liveTestToken").addEventListener("input", () => {
      try { sessionStorage.setItem(TOKEN_KEY, $("liveTestToken").value); } catch (_) {}
    });
    $("liveTestDeploy").addEventListener("click", deployLiveTest);
    $("liveTestOpen").addEventListener("click", openPreview);
    $("liveTestRefresh").addEventListener("click", checkSetup);
    $("liveTestStop").addEventListener("click", stopPreview);
  }

  function status(text, kind = "") {
    const box = $("liveTestStatus");
    if (!box) return;
    box.textContent = text;
    box.dataset.kind = kind;
  }

  function setBusy(busy, label = "") {
    ["liveTestDeploy", "liveTestRefresh", "liveTestStop"].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = busy;
    });
    const deploy = $("liveTestDeploy");
    if (deploy) deploy.textContent = busy ? (label || "WORKING…") : "▶ DEPLOY LIVE TEST";
  }

  function currentCredentials() {
    const accountId = $("liveTestAccount")?.value.trim() || "";
    const apiToken = $("liveTestToken")?.value.trim() || "";
    if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("Enter your 32-character Cloudflare Account ID.");
    if (!apiToken) throw new Error("Enter a Cloudflare API token.");
    return { accountId, apiToken };
  }

  function currentRepo() {
    return $("repoSelect")?.value || "";
  }

  function currentBranch() {
    return $("branchSelect")?.value || "";
  }

  async function api(path, payload) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || text || `Live Test request failed (${res.status}).`);
    }
    return data;
  }

  async function deployLiveTest() {
    try {
      const { accountId, apiToken } = currentCredentials();
      const repo = currentRepo();
      const branch = currentBranch();
      if (repo !== TARGET_REPO) {
        throw new Error(`Live Test is locked to ${TARGET_REPO}. Pull/select RiftCity first so the Editor itself can never be deployed by mistake.`);
      }
      if (!branch) throw new Error("Choose the RiftCity branch you want to test.");

      setBusy(true, "PACKING WORKSPACE…");
      status("Saving the active file and collecting the current LOCAL workspace…\nGitHub is not being changed.");
      const files = await collectWorkspace();

      setBusy(true, "DEPLOYING…");
      status(`Uploading ${files.length} workspace files to the isolated Cloudflare preview…\nThis can take a little while on iPhone.`);
      const result = await api("/api/live-test/deploy", { accountId, apiToken, repo, branch, files });

      try { localStorage.setItem(LAST_URL_KEY, result.url || ""); } catch (_) {}
      status([
        "✅ LIVE TEST DEPLOYED",
        `URL: ${result.url}`,
        `Worker: ${result.worker}`,
        result.d1 ? `D1: ${result.d1}` : "D1: not used by this project",
        result.r2 ? `R2: ${result.r2}` : "R2: not used by this project",
        `Modules: ${result.modules ?? "?"} · Assets: ${result.assets ?? "?"}`,
        "",
        "GitHub: UNCHANGED"
      ].join("\n"), "ok");

      const open = $("liveTestOpen");
      if (open) open.disabled = !result.url;
      if (result.url && confirm("Live Test deployed. Open RiftCity preview now?")) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      console.error("Live Test deploy failed", error);
      status("❌ " + (error.message || error), "error");
      alert("Live Test failed: " + (error.message || error));
    } finally {
      setBusy(false);
    }
  }

  async function checkSetup() {
    try {
      const { accountId, apiToken } = currentCredentials();
      setBusy(true, "CHECKING…");
      status("Checking Cloudflare access and preview resources…");
      const result = await api("/api/live-test/status", { accountId, apiToken });
      if (result.url) {
        try { localStorage.setItem(LAST_URL_KEY, result.url); } catch (_) {}
      }
      status([
        "✅ Cloudflare connection works.",
        `Preview Worker: ${result.workerExists ? "deployed" : "not deployed yet"}`,
        `Preview D1: ${result.d1 || "will be created on first deploy"}`,
        `Preview R2: ${result.r2 || "will be created on first deploy"}`,
        result.url ? `URL: ${result.url}` : "",
        "",
        "GitHub: UNCHANGED"
      ].filter(Boolean).join("\n"));
    } catch (error) {
      status("❌ " + (error.message || error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function stopPreview() {
    try {
      const { accountId, apiToken } = currentCredentials();
      if (!confirm("Stop/delete the RiftCity preview Worker?\n\nPreview D1/R2 test data will be kept for your next Live Test.")) return;
      setBusy(true, "STOPPING…");
      const result = await api("/api/live-test/stop", { accountId, apiToken });
      status(result.removed ? "Preview Worker stopped. Test D1/R2 data was kept." : "Preview Worker was already stopped.");
    } catch (error) {
      status("❌ " + (error.message || error), "error");
    } finally {
      setBusy(false);
    }
  }

  function openPreview() {
    let url = "";
    try { url = localStorage.getItem(LAST_URL_KEY) || ""; } catch (_) {}
    if (!url) return alert("No preview URL yet. Deploy Live Test first.");
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function openModal() {
    ensureModal();
    const repo = currentRepo();
    let account = "", token = "", url = "";
    try {
      account = localStorage.getItem(ACCOUNT_KEY) || "";
      token = sessionStorage.getItem(TOKEN_KEY) || "";
      url = localStorage.getItem(LAST_URL_KEY) || "";
    } catch (_) {}
    $("liveTestAccount").value = account;
    $("liveTestToken").value = token;
    $("liveTestOpen").disabled = !url;
    status(repo === TARGET_REPO
      ? `Ready to deploy ${repo} (${currentBranch() || "choose a branch"}).\nOnly the LOCAL browser workspace is sent to Cloudflare.`
      : `Select/pull ${TARGET_REPO} first.\nCurrent repo: ${repo || "none"}`);
    $("liveTestModal").classList.remove("hidden");
  }

  function closeModal() {
    $("liveTestModal")?.classList.add("hidden");
  }

  function bind() {
    ensureModal();
    $("liveTestBtn")?.addEventListener("click", openModal);
    // Expose a tiny bridge for the immersive V11 Tools menu and future editor UI.
    window.RiftCityLiveTest = Object.freeze({ open: openModal, deploy: deployLiveTest, openPreview });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
