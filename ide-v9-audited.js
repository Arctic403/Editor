/* =========================================================
   Mobile Workspace IDE Add-on v9
   RiftCity development tools
   ---------------------------------------------------------
   Designed to sit ON TOP of app-safari-v8.js.
   Does not replace the working GitHub / IndexedDB core.
   ========================================================= */

(() => {
    "use strict";

    const IDE_VERSION = "RiftCity-IDE-v9.1-tabs";
    const HISTORY_DB = "MobileWorkspace_IDE_History_v1";
    const HISTORY_STORE = "snapshots";
    const MAX_HISTORY_PER_FILE = 15;

    const openTabs = [];
    let activeTab = "";
    let historyDb = null;
    let historyTimer = null;
    let pushReviewBypass = false;
    let previewFrame = null;
    let previewConsole = [];

    console.info("Loaded", IDE_VERSION);

    /* =====================================================
       BASIC HELPERS
       ===================================================== */

    function $(id) {
        return document.getElementById(id);
    }

    function escapeHtml(value = "") {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function basename(path = "") {
        return path.split("/").pop() || path;
    }

    function dirname(path = "") {
        const parts = path.split("/");
        parts.pop();
        return parts.join("/");
    }

    function extname(path = "") {
        const file = basename(path);
        const i = file.lastIndexOf(".");
        return i >= 0 ? file.slice(i) : "";
    }

    function withoutExtension(path = "") {
        return path.replace(/\.[^/.]+$/, "");
    }

    function isTextFile(path) {
        return /\.(txt|md|json|js|jsx|ts|tsx|css|scss|sass|less|html|htm|xml|svg|cfg|ini|lua|py|cpp|c|h|hpp|cs|java|go|rs|php|rb|sh|bat|ps1|sql|yaml|yml|toml|env|gitignore|properties|log|swift|kt|kts|dart|r|m|mm|vue|svelte|astro|graphql|gql|prisma|diff|patch)$/i.test(path);
    }

    function normalizePath(path = "") {
        const parts = [];

        path.replace(/\\/g, "/").split("/").forEach(part => {
            if (!part || part === ".") return;
            if (part === "..") {
                parts.pop();
            } else {
                parts.push(part);
            }
        });

        return parts.join("/");
    }

    function relativePath(fromFile, toFile, stripExt = true) {
        const fromParts = dirname(fromFile).split("/").filter(Boolean);
        const toParts = toFile.split("/").filter(Boolean);

        let same = 0;

        while (
            same < fromParts.length &&
            same < toParts.length &&
            fromParts[same] === toParts[same]
        ) {
            same++;
        }

        const up = fromParts.slice(same).map(() => "..");
        const down = toParts.slice(same);

        let result = [...up, ...down].join("/");

        if (stripExt) {
            result = withoutExtension(result);
        }

        if (!result.startsWith(".")) {
            result = "./" + result;
        }

        return result;
    }

    function debounce(fn, delay = 300) {
        let timer;

        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    }

    async function workspaceFiles() {
        if (typeof getAllWorkspaceFiles !== "function") {
            throw new Error("Workspace API is unavailable.");
        }

        return await getAllWorkspaceFiles();
    }

    async function getWorkspaceFile(path) {
        const files = await workspaceFiles();
        return files.find(file => file.name === path) || null;
    }

    async function writeWorkspaceFile(path, content) {
        if (typeof saveFileToDb !== "function") {
            throw new Error("Workspace save API unavailable.");
        }

        await saveFileToDb(path, content);
    }

    async function removeWorkspaceFileNoPrompt(path) {
        const database = await getDatabase();

        await new Promise((resolve, reject) => {
            const tx = database.transaction("files", "readwrite");
            const store = tx.objectStore("files");

            store.delete(path);

            tx.oncomplete = resolve;
            tx.onerror = () =>
                reject(tx.error || new Error("Unable to delete workspace file."));
            tx.onabort = () =>
                reject(tx.error || new Error("Delete transaction aborted."));
        });
    }

    function lineFromOffset(text, offset) {
        return text.slice(0, offset).split("\n").length;
    }

    function getSelectedWord() {
        const editor = $("editor");
        if (!editor) return "";

        const pos = editor.selectionStart;
        const text = editor.value;

        let start = pos;
        let end = pos;

        while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
        while (end < text.length && /[\w$]/.test(text[end])) end++;

        return text.slice(start, end);
    }

    async function jumpToProjectResult(path, line = 1) {
        await openFile(path);

        requestAnimationFrame(() => {
            if (typeof jumpToLine === "function") {
                jumpToLine(line);
            }
        });
    }

    /* =====================================================
       IDE UI
       ===================================================== */

    function injectStyles() {
        const style = document.createElement("style");

        style.id = "riftcityIdeStyles";

        style.textContent = `
            .ide-v9-toolbar {
                display:flex;
                align-items:center;
                gap:6px;
                padding:5px 7px;
                border-bottom:1px solid rgba(255,255,255,.1);
                background:rgba(0,0,0,.10);
            }

            .ide-v9-toolbar-toggle,
            .ide-editor-actions-toggle {
                flex:none;
                min-height:34px;
                display:inline-flex;
                align-items:center;
                justify-content:center;
                gap:6px;
                padding:6px 10px;
                border:1px solid #374151;
                border-radius:7px;
                background:#17202e;
                color:#fff;
                font-weight:700;
                cursor:pointer;
                -webkit-tap-highlight-color:transparent;
                touch-action:manipulation;
            }

            .ide-v9-toolbar-tools {
                display:flex;
                gap:6px;
                flex-wrap:wrap;
            }

            .ide-v9-toolbar-tools.hidden { display:none; }
            .ide-v9-toolbar-tools button { font-size:12px; }

            .ide-tabs {
                display:flex;
                gap:4px;
                overflow-x:auto;
                padding:4px 6px;
                background:#111722;
                border-bottom:1px solid #2d3748;
                scrollbar-width:thin;
            }

            .ide-tab {
                flex:none;
                display:flex;
                align-items:stretch;
                border:1px solid #374151;
                border-radius:7px;
                background:#1f2937;
                color:#ddd;
                font-size:12px;
                max-width:220px;
                overflow:hidden;
            }

            .ide-tab-open {
                min-width:0;
                display:flex;
                align-items:center;
                padding:7px 8px;
                border:0;
                background:transparent;
                color:inherit;
                font:inherit;
                cursor:pointer;
            }

            .ide-tab.active {
                border-color:#6aa8ff;
                background:#29384f;
                color:#fff;
            }

            .ide-tab-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

            .ide-tab-close {
                flex:none;
                width:34px;
                min-height:34px;
                border:0;
                border-left:1px solid rgba(255,255,255,.08);
                background:transparent;
                color:inherit;
                opacity:.8;
                font-size:14px;
                cursor:pointer;
                -webkit-tap-highlight-color:transparent;
                touch-action:manipulation;
            }

            .ide-tab-close:hover,
            .ide-tab-close:active { opacity:1; background:rgba(220,38,38,.22); }

            .ide-mobile-filebar {
                display:none;
                align-items:center;
                gap:6px;
                padding:5px 7px;
                background:#111722;
                border-bottom:1px solid #2d3748;
            }

            .ide-mobile-file-select {
                flex:1;
                min-width:0;
                height:36px;
                border:1px solid #374151;
                border-radius:7px;
                background:#17202e;
                color:#fff;
                padding:0 8px;
                font-size:13px;
            }

            .ide-mobile-close {
                flex:none;
                width:38px;
                height:36px;
                border:1px solid #7f1d1d;
                border-radius:7px;
                background:#991b1b;
                color:white;
                font-weight:800;
                font-size:16px;
            }

            .ide-tools-popover {
                position:fixed;
                z-index:99998;
                left:8px;
                right:8px;
                top:calc(env(safe-area-inset-top, 0px) + 54px);
                max-height:70vh;
                overflow:auto;
                padding:8px;
                border:1px solid #374151;
                border-radius:10px;
                background:#111827;
                box-shadow:0 16px 48px rgba(0,0,0,.55);
            }

            .ide-tools-popover.hidden { display:none; }
            .ide-tools-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
            .ide-tools-grid button { width:100%; min-height:40px; }

            .ide-modal {
                position:fixed;
                inset:0;
                z-index:99999;
                display:flex;
                align-items:center;
                justify-content:center;
                background:rgba(0,0,0,.72);
                padding:10px;
            }

            .ide-modal.hidden {
                display:none;
            }

            .ide-modal-card {
                width:min(1000px, 96vw);
                max-height:92vh;
                display:flex;
                flex-direction:column;
                background:#111827;
                border:1px solid #374151;
                border-radius:10px;
                box-shadow:0 20px 60px rgba(0,0,0,.5);
                overflow:hidden;
                color:#eee;
            }

            .ide-modal-head {
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:10px;
                padding:11px 12px;
                background:#182131;
                border-bottom:1px solid #374151;
            }

            .ide-modal-head strong {
                overflow:hidden;
                text-overflow:ellipsis;
                white-space:nowrap;
            }

            .ide-modal-body {
                padding:10px;
                overflow:auto;
                -webkit-overflow-scrolling:touch;
                flex:1;
            }

            .ide-modal-footer {
                display:flex;
                justify-content:flex-end;
                gap:7px;
                padding:9px;
                border-top:1px solid #374151;
                background:#151d2a;
            }

            .ide-input,
            .ide-select,
            .ide-textarea {
                width:100%;
                box-sizing:border-box;
                padding:8px;
                margin:4px 0;
                border-radius:6px;
                border:1px solid #3d4a5c;
                background:#0c111a;
                color:#fff;
                font:inherit;
            }

            .ide-textarea {
                min-height:180px;
                resize:vertical;
                font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                font-size:12px;
            }

            .ide-result {
                display:block;
                width:100%;
                text-align:left;
                padding:8px;
                margin:5px 0;
                border:1px solid #303b4b;
                border-radius:6px;
                background:#17202e;
                color:#eee;
                cursor:pointer;
            }

            .ide-result:hover {
                background:#1e2b3d;
            }

            .ide-path {
                color:#83b7ff;
                font-size:12px;
                font-weight:700;
            }

            .ide-line {
                color:#97a6b8;
                font-size:11px;
            }

            .ide-preview-wrap {
                display:flex;
                flex-direction:column;
                height:72vh;
            }

            .ide-preview-frame {
                flex:1;
                width:100%;
                border:0;
                background:white;
            }

            .ide-console {
                height:160px;
                overflow:auto;
                padding:8px;
                background:#05070a;
                border-top:1px solid #343d49;
                font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size:11px;
                white-space:pre-wrap;
            }

            .ide-console-error {
                color:#ff8585;
            }

            .ide-console-warn {
                color:#ffd479;
            }

            .ide-console-log {
                color:#d2dae5;
            }

            .ide-diff-file {
                margin:10px 0 18px;
                border:1px solid #354052;
                border-radius:7px;
                overflow:hidden;
            }

            .ide-diff-title {
                padding:7px 9px;
                font-weight:700;
                background:#172131;
            }

            .ide-diff {
                margin:0;
                padding:8px;
                overflow:auto;
                background:#080b10;
                font-size:11px;
                line-height:1.5;
                font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
                white-space:pre;
            }

            .ide-add {
                color:#9ee8a6;
            }

            .ide-del {
                color:#ff9f9f;
            }

            .ide-context {
                color:#b6bec9;
            }

            .ide-badge {
                display:inline-block;
                margin-left:5px;
                padding:2px 6px;
                border-radius:999px;
                font-size:10px;
                background:#29384f;
            }

            .ide-grid {
                display:grid;
                grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
                gap:8px;
            }

            .ide-card {
                padding:9px;
                border:1px solid #354052;
                border-radius:7px;
                background:#151e2b;
            }

            .ide-section-title {
                font-weight:700;
                margin:12px 0 6px;
            }

            .ide-small {
                font-size:11px;
                opacity:.75;
            }

            .ide-good {
                color:#8ee59a;
            }

            .ide-warning {
                color:#ffd271;
            }

            .ide-error {
                color:#ff8d8d;
            }

            @media (max-width:650px) {
                .editor-header {
                    min-height:auto !important;
                    padding:6px 8px !important;
                    align-items:center !important;
                    flex-direction:row !important;
                    gap:6px !important;
                }

                .editor-header .active-file-info {
                    flex:1;
                    min-width:0;
                    overflow:hidden;
                }

                .editor-header .active-file-info #activeFileLabel {
                    display:block;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    white-space:nowrap;
                    font-size:12px;
                }

                .editor-actions.ide-mobile-collapsible { display:none !important; }
                .ide-editor-actions-toggle { display:none !important; }

                .ide-v9-toolbar {
                    padding:4px 7px;
                    justify-content:flex-end;
                }

                .ide-v9-toolbar-toggle {
                    min-height:32px;
                    padding:5px 9px;
                    font-size:12px;
                }

                .ide-v9-toolbar-tools { display:none !important; }
                .ide-tabs { display:none !important; }
                .ide-mobile-filebar { display:flex; }

                .ide-modal-card { width:100%; max-height:95vh; }
            }

            @media (min-width:651px) {
                .ide-mobile-filebar { display:none !important; }
            }
            }
        `;

        document.head.appendChild(style);
    }

    function createButton(label, action, className = "btn btn-sm btn-secondary") {
        const btn = document.createElement("button");

        btn.type = "button";
        btn.className = className;
        btn.textContent = label;
        btn.addEventListener("click", action);

        return btn;
    }

    function injectToolbar() {
        const editorSection = $("editorSection");
        if (!editorSection || $("ideV9Toolbar")) return;

        const bar = document.createElement("div");
        bar.id = "ideV9Toolbar";
        bar.className = "ide-v9-toolbar";

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "ide-v9-toolbar-toggle";
        toggle.textContent = "🧰 Tools";

        const tools = document.createElement("div");
        tools.id = "ideV9ToolbarTools";
        tools.className = "ide-v9-toolbar-tools hidden";

        const ideActions = [
            ["🔎 Project Search", showProjectSearch],
            ["🧾 Git Diff", showGitDiff],
            ["🩺 Diagnostics", runDiagnostics],
            ["▶ Preview", previewProject],
            ["🎯 Definition", goToDefinition],
            ["🔗 References", findReferences],
            ["📥 Auto Import", autoImportSelected],
            ["✏ Rename File", renameCurrentFile],
            ["🕘 History", showHistory],
            ["💾 Save Data", showSaveDataViewer],
            ["🛠 RiftCity Dev", showRiftCityDevPanel]
        ];

        ideActions.forEach(([label, action]) => tools.append(createButton(label, action)));

        const popover = document.createElement("div");
        popover.id = "ideMobileToolsPopover";
        popover.className = "ide-tools-popover hidden";

        const grid = document.createElement("div");
        grid.className = "ide-tools-grid";

        const coreActions = [
            ["🔍 Find File", "quickOpenBtn"],
            ["▥ Split", "splitPaneBtn"],
            ["⚓ Jump L#", "jumpLineBtn"],
            ["🔍 Find/Replace", "searchToggleBtn"],
            ["💾 Save", "saveLocalBtn"],
            ["☁️ Push", "pushGitHubBtn"],
            ["⛶ Fullscreen", "fullscreenBtn"]
        ];

        coreActions.forEach(([label, id]) => {
            grid.append(createButton(label, () => {
                popover.classList.add("hidden");
                $(id)?.click();
            }));
        });

        ideActions.forEach(([label, action]) => {
            grid.append(createButton(label, () => {
                popover.classList.add("hidden");
                action();
            }));
        });

        popover.appendChild(grid);
        document.body.appendChild(popover);

        toggle.addEventListener("click", () => {
            if (window.matchMedia("(max-width:650px)").matches) {
                popover.classList.toggle("hidden");
            } else {
                tools.classList.toggle("hidden");
            }
        });

        bar.append(toggle, tools);

        const breadcrumb = $("breadcrumbBar");
        if (breadcrumb) editorSection.insertBefore(bar, breadcrumb);
        else editorSection.prepend(bar);
    }

    function createModal() {
        if ($("ideV9Modal")) return;

        const modal = document.createElement("div");

        modal.id = "ideV9Modal";
        modal.className = "ide-modal hidden";

        modal.innerHTML = `
            <div class="ide-modal-card">
                <div class="ide-modal-head">
                    <strong id="ideModalTitle">IDE</strong>
                    <button class="btn btn-sm btn-danger" id="ideModalClose">✕</button>
                </div>

                <div class="ide-modal-body" id="ideModalBody"></div>

                <div class="ide-modal-footer" id="ideModalFooter"></div>
            </div>
        `;

        document.body.appendChild(modal);

        $("ideModalClose").addEventListener("click", closeModal);

        modal.addEventListener("click", e => {
            if (e.target === modal) closeModal();
        });
    }

    function showModal(title, html = "") {
        createModal();

        $("ideModalTitle").textContent = title;
        $("ideModalBody").innerHTML = html;
        $("ideModalFooter").innerHTML = "";
        $("ideV9Modal").classList.remove("hidden");

        return {
            body: $("ideModalBody"),
            footer: $("ideModalFooter")
        };
    }

    function closeModal() {
        const modal = $("ideV9Modal");

        if (modal) {
            modal.classList.add("hidden");
        }
    }

    /* =====================================================
       MULTI FILE TABS — AUDITED SINGLE SOURCE OF TRUTH
       ===================================================== */

    let tabSwitchInProgress = false;

    function injectTabs() {
        const workspacePanes = $("workspacePanes");
        if (!workspacePanes || $("ideTabs")) return;

        const tabs = document.createElement("div");
        tabs.id = "ideTabs";
        tabs.className = "ide-tabs";

        const mobileBar = document.createElement("div");
        mobileBar.id = "ideMobileFilebar";
        mobileBar.className = "ide-mobile-filebar";

        const select = document.createElement("select");
        select.id = "ideMobileFileSelect";
        select.className = "ide-mobile-file-select";
        select.setAttribute("aria-label", "Open files");

        const close = document.createElement("button");
        close.type = "button";
        close.className = "ide-mobile-close";
        close.textContent = "✕";
        close.title = "Close current file";
        close.setAttribute("aria-label", "Close current file");

        select.addEventListener("change", async () => {
            if (select.value) await switchToTab(select.value);
        });

        close.addEventListener("click", async e => {
            e.preventDefault();
            e.stopPropagation();
            const path = currentEditorPath() || activeTab;
            if (path) await closeTab(path);
        });

        mobileBar.append(select, close);
        workspacePanes.parentNode.insertBefore(mobileBar, workspacePanes);
        workspacePanes.parentNode.insertBefore(tabs, workspacePanes);
        renderTabs();
    }

    function currentEditorPath() {
        return $("editor")?.dataset.filename || "";
    }

    function registerCurrentFile() {
        const filename = currentEditorPath();

        // Empty filename means the core editor really closed its file.
        // Mirror that state instead of leaving a ghost tab behind.
        if (!filename) {
            if (!tabSwitchInProgress && activeTab) {
                const i = openTabs.indexOf(activeTab);
                if (i >= 0) openTabs.splice(i, 1);
                activeTab = "";
                renderTabs();
            }
            return;
        }

        activeTab = filename;
        if (!openTabs.includes(filename)) openTabs.push(filename);
        renderTabs();
    }

    function resetCoreEditor() {
        const editor = $("editor");
        if (!editor) return;

        tabSwitchInProgress = true;
        editor.value = "";
        editor.dataset.filename = "";

        const label = $("activeFileLabel");
        if (label) label.textContent = "No file selected";

        try { if (typeof updateLineNumbers === "function") updateLineNumbers(); } catch {}
        try { if (typeof updateHighlights === "function") updateHighlights(); } catch {}
        try { if (typeof renderCodeBlockNav === "function") renderCodeBlockNav(""); } catch {}
        try { if (typeof updateBreadcrumbs === "function") updateBreadcrumbs(""); } catch {}
        try { if (typeof updateDirtyIndicator === "function") updateDirtyIndicator(false); } catch {}

        queueMicrotask(() => { tabSwitchInProgress = false; });
    }

    async function switchToTab(path) {
        if (!path || !openTabs.includes(path)) return;

        tabSwitchInProgress = true;
        try {
            await openFile(path);
            activeTab = path;
            renderTabs();
        } finally {
            setTimeout(() => { tabSwitchInProgress = false; }, 0);
        }
    }

    async function closeTab(path) {
        if (!path) return;

        const index = openTabs.indexOf(path);
        if (index >= 0) openTabs.splice(index, 1);

        const isCurrent = currentEditorPath() === path || activeTab === path;
        if (!isCurrent) {
            renderTabs();
            return;
        }

        const nextPath = openTabs[index] || openTabs[index - 1] || openTabs[0] || "";
        activeTab = "";

        if (nextPath) {
            await switchToTab(nextPath);
        } else {
            resetCoreEditor();
            renderTabs();
        }
    }

    function renderTabs() {
        const container = $("ideTabs");
        const select = $("ideMobileFileSelect");

        if (container) {
            container.innerHTML = "";
            openTabs.forEach(path => {
                const tab = document.createElement("div");
                tab.className = "ide-tab" + (path === activeTab ? " active" : "");
                tab.title = path;

                const open = document.createElement("button");
                open.type = "button";
                open.className = "ide-tab-open";
                open.textContent = basename(path);
                open.addEventListener("click", () => switchToTab(path));

                const close = document.createElement("button");
                close.type = "button";
                close.className = "ide-tab-close";
                close.textContent = "✕";
                close.setAttribute("aria-label", `Close ${basename(path)}`);
                close.addEventListener("click", async e => {
                    e.preventDefault();
                    e.stopPropagation();
                    await closeTab(path);
                });

                tab.append(open, close);
                container.appendChild(tab);
            });
        }

        if (select) {
            select.innerHTML = "";
            if (!openTabs.length) {
                const option = document.createElement("option");
                option.value = "";
                option.textContent = "No file open";
                select.appendChild(option);
                select.disabled = true;
            } else {
                select.disabled = false;
                openTabs.forEach(path => {
                    const option = document.createElement("option");
                    option.value = path;
                    option.textContent = basename(path);
                    option.title = path;
                    select.appendChild(option);
                });
                select.value = activeTab && openTabs.includes(activeTab) ? activeTab : openTabs[0];
            }
        }
    }

    function setupMobileEditorActions() {
        const actions = document.querySelector("#editorSection .editor-actions");
        if (actions) actions.classList.add("ide-mobile-collapsible");
    }

    function hookCoreCloseButton() {
        const button = $("closeFileBtn");
        if (!button || button.dataset.ideTabHooked === "1") return;
        button.dataset.ideTabHooked = "1";

        button.addEventListener("click", async event => {
            const path = currentEditorPath() || activeTab;
            if (!path) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            await closeTab(path);
        }, true);
    }

    function watchActiveFile() {
        const editor = $("editor");
        if (!editor) return;

        const observer = new MutationObserver(() => registerCurrentFile());
        observer.observe(editor, { attributes:true, attributeFilter:["data-filename"] });
    }

    /* =====================================================
       PROJECT-WIDE SEARCH / REPLACE
       ===================================================== */

    async function projectSearch(query, caseSensitive = false) {
        const files = await workspaceFiles();
        const results = [];

        if (!query) return results;

        const needle = caseSensitive ? query : query.toLowerCase();

        for (const file of files) {
            if (!isTextFile(file.name)) continue;
            if (typeof file.content !== "string") continue;

            const lines = file.content.split("\n");

            lines.forEach((line, index) => {
                const source = caseSensitive ? line : line.toLowerCase();

                if (source.includes(needle)) {
                    results.push({
                        path: file.name,
                        line: index + 1,
                        preview: line.trim().slice(0, 240)
                    });
                }
            });
        }

        return results;
    }

    async function replaceProjectText(
        search,
        replacement,
        caseSensitive = false
    ) {
        const files = await workspaceFiles();

        let filesChanged = 0;
        let replacements = 0;

        for (const file of files) {
            if (!isTextFile(file.name)) continue;
            if (typeof file.content !== "string") continue;

            let content = file.content;
            let changed = false;

            if (caseSensitive) {
                const count = content.split(search).length - 1;

                if (count > 0) {
                    content = content.split(search).join(replacement);
                    replacements += count;
                    changed = true;
                }
            } else {
                const regex = new RegExp(
                    search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                    "gi"
                );

                const matches = content.match(regex);

                if (matches?.length) {
                    replacements += matches.length;
                    content = content.replace(regex, replacement);
                    changed = true;
                }
            }

            if (changed) {
                await createHistorySnapshot(
                    file.name,
                    file.content,
                    "Before project replace"
                );

                await writeWorkspaceFile(file.name, content);
                filesChanged++;
            }
        }

        if (typeof loadFiles === "function") {
            await loadFiles();
        }

        const editor = $("editor");

        if (editor?.dataset.filename) {
            await openFile(editor.dataset.filename);
        }

        return {
            filesChanged,
            replacements
        };
    }

    function showProjectSearch() {
        const modal = showModal(
            "Project Search",
            `
                <input
                    id="ideProjectSearchInput"
                    class="ide-input"
                    placeholder="Search every file..."
                >

                <input
                    id="ideProjectReplaceInput"
                    class="ide-input"
                    placeholder="Replace with..."
                >

                <label class="ide-small">
                    <input type="checkbox" id="ideProjectCase">
                    Case sensitive
                </label>

                <div id="ideProjectSearchStatus" class="ide-small"></div>
                <div id="ideProjectSearchResults"></div>
            `
        );

        const input = $("ideProjectSearchInput");
        const replaceInput = $("ideProjectReplaceInput");
        const status = $("ideProjectSearchStatus");
        const resultsBox = $("ideProjectSearchResults");

        async function refresh() {
            const query = input.value;

            if (!query) {
                status.textContent = "";
                resultsBox.innerHTML = "";
                return;
            }

            status.textContent = "Searching workspace…";

            const results = await projectSearch(
                query,
                $("ideProjectCase").checked
            );

            status.textContent =
                `${results.length} result${results.length === 1 ? "" : "s"}`;

            resultsBox.innerHTML = "";

            results.slice(0, 500).forEach(result => {
                const item = document.createElement("button");

                item.className = "ide-result";

                item.innerHTML = `
                    <div class="ide-path">
                        ${escapeHtml(result.path)}
                    </div>

                    <div class="ide-line">
                        Line ${result.line}
                    </div>

                    <div>
                        ${escapeHtml(result.preview)}
                    </div>
                `;

                item.addEventListener("click", async () => {
                    closeModal();
                    await jumpToProjectResult(result.path, result.line);
                });

                resultsBox.appendChild(item);
            });

            if (results.length > 500) {
                resultsBox.insertAdjacentHTML(
                    "beforeend",
                    `<div class="ide-small">
                        Showing first 500 results.
                    </div>`
                );
            }
        }

        input.addEventListener("input", debounce(refresh, 180));
        $("ideProjectCase").addEventListener("change", refresh);

        modal.footer.append(
            createButton("Replace All", async () => {
                const search = input.value;

                if (!search) return;

                const replacement = replaceInput.value;

                if (
                    !confirm(
                        `Replace "${search}" across the entire workspace?`
                    )
                ) {
                    return;
                }

                const result = await replaceProjectText(
                    search,
                    replacement,
                    $("ideProjectCase").checked
                );

                alert(
                    `Replaced ${result.replacements} occurrence(s) across ` +
                    `${result.filesChanged} file(s).`
                );

                await refresh();
            }, "btn btn-sm btn-warning")
        );

        setTimeout(() => input.focus(), 50);
    }

    /* =====================================================
       GIT CHANGE / DIFF REVIEW
       ===================================================== */

    async function getGitHubBaselineText(path, state) {
        const baseline = state?.files?.[path];

        if (!baseline?.blobSha) return "";

        const token = localStorage.getItem("gh_token");

        if (!token) {
            throw new Error("GitHub PAT is not connected.");
        }

        const repoPath =
            typeof githubRepoApiPath === "function"
                ? githubRepoApiPath(state.repo)
                : state.repo
                      .split("/")
                      .map(encodeURIComponent)
                      .join("/");

        const response = await fetch(
            `https://api.github.com/repos/${repoPath}/git/blobs/${encodeURIComponent(
                baseline.blobSha
            )}`,
            {
                headers:
                    typeof githubHeaders === "function"
                        ? githubHeaders(token)
                        : {
                              Authorization: `Bearer ${token}`,
                              Accept: "application/vnd.github+json"
                          }
            }
        );

        if (!response.ok) {
            throw new Error(
                `Unable to retrieve old version of ${path}.`
            );
        }

        const data = await response.json();

        if (data.encoding !== "base64") {
            return "";
        }

        const clean = String(data.content || "").replace(/\s/g, "");

        try {
            const bytes = Uint8Array.from(atob(clean), c =>
                c.charCodeAt(0)
            );

            return new TextDecoder().decode(bytes);
        } catch {
            return "";
        }
    }

    function simpleLineDiff(oldText, newText) {
        const oldLines = String(oldText).split("\n");
        const newLines = String(newText).split("\n");

        const max = Math.max(oldLines.length, newLines.length);
        const output = [];

        for (let i = 0; i < max; i++) {
            const oldLine = oldLines[i];
            const newLine = newLines[i];

            if (oldLine === newLine) {
                if (oldLine !== undefined) {
                    output.push({
                        type: "context",
                        text: "  " + oldLine
                    });
                }

                continue;
            }

            if (oldLine !== undefined) {
                output.push({
                    type: "del",
                    text: "- " + oldLine
                });
            }

            if (newLine !== undefined) {
                output.push({
                    type: "add",
                    text: "+ " + newLine
                });
            }
        }

        return output;
    }

    async function currentGitChanges() {
        if (
            typeof loadGitSyncState !== "function" ||
            typeof calculateWorkspaceChanges !== "function"
        ) {
            throw new Error("Git sync API is unavailable.");
        }

        const state = loadGitSyncState();

        if (!state) {
            throw new Error(
                "Pull the GitHub repo once first so a sync baseline exists."
            );
        }

        const changes = await calculateWorkspaceChanges(state);

        return {
            state,
            changes
        };
    }

    async function buildDiffHtml() {
        const { state, changes } = await currentGitChanges();

        if (!changes.total) {
            return {
                html: `
                    <p class="ide-good">
                        Workspace matches GitHub. Nothing to push.
                    </p>
                `,
                total: 0
            };
        }

        let html = `
            <div class="ide-card">
                <strong>${escapeHtml(state.repo)}</strong>
                <span class="ide-badge">${escapeHtml(state.branch)}</span>
                <div class="ide-small">
                    ${changes.modified.length} modified ·
                    ${changes.added.length} new ·
                    ${changes.deleted.length} deleted
                </div>
            </div>
        `;

        for (const file of changes.modified) {
            let oldText = "";

            try {
                oldText = await getGitHubBaselineText(
                    file.name,
                    state
                );
            } catch (err) {
                console.warn(err);
            }

            const diff = simpleLineDiff(oldText, file.content);

            html += `
                <div class="ide-diff-file">
                    <div class="ide-diff-title">
                        Modified · ${escapeHtml(file.name)}
                    </div>

                    <pre class="ide-diff">${
                        diff
                            .slice(0, 1500)
                            .map(line => {
                                const cls =
                                    line.type === "add"
                                        ? "ide-add"
                                        : line.type === "del"
                                        ? "ide-del"
                                        : "ide-context";

                                return `<span class="${cls}">${escapeHtml(
                                    line.text
                                )}</span>`;
                            })
                            .join("\n")
                    }</pre>
                </div>
            `;
        }

        for (const file of changes.added) {
            html += `
                <div class="ide-diff-file">
                    <div class="ide-diff-title">
                        New · ${escapeHtml(file.name)}
                    </div>

                    <pre class="ide-diff ide-add">${escapeHtml(
                        String(file.content).slice(0, 50000)
                    )}</pre>
                </div>
            `;
        }

        for (const file of changes.deleted) {
            let oldText = "";

            try {
                oldText = await getGitHubBaselineText(
                    file.name,
                    state
                );
            } catch {}

            html += `
                <div class="ide-diff-file">
                    <div class="ide-diff-title">
                        Deleted · ${escapeHtml(file.name)}
                    </div>

                    <pre class="ide-diff ide-del">${escapeHtml(
                        oldText.slice(0, 50000)
                    )}</pre>
                </div>
            `;
        }

        return {
            html,
            total: changes.total
        };
    }

    async function showGitDiff() {
        const modal = showModal(
            "Git Changes",
            `<div class="ide-small">Building diff…</div>`
        );

        try {
            const result = await buildDiffHtml();

            modal.body.innerHTML = result.html;
        } catch (err) {
            modal.body.innerHTML = `
                <div class="ide-error">
                    ${escapeHtml(err.message)}
                </div>
            `;
        }
    }

    function interceptPushChanges() {
        const button = $("pushAllGitHubBtn");

        if (!button) return;

        button.addEventListener(
            "click",
            async event => {
                if (pushReviewBypass) {
                    pushReviewBypass = false;
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                const modal = showModal(
                    "Review Push",
                    `<div class="ide-small">
                        Checking changed files…
                    </div>`
                );

                try {
                    const result = await buildDiffHtml();

                    modal.body.innerHTML = result.html;

                    if (!result.total) return;

                    modal.footer.append(
                        createButton(
                            `Push ${result.total} Change${
                                result.total === 1 ? "" : "s"
                            }`,
                            () => {
                                closeModal();
                                pushReviewBypass = true;
                                button.click();
                            },
                            "btn btn-sm btn-success"
                        )
                    );
                } catch (err) {
                    modal.body.innerHTML = `
                        <div class="ide-error">
                            ${escapeHtml(err.message)}
                        </div>
                    `;
                }
            },
            true
        );
    }

    /* =====================================================
       TYPESCRIPT / IMPORT DIAGNOSTICS
       ===================================================== */

    let typescriptLoader = null;

    async function loadTypeScript() {
        if (window.ts) return window.ts;

        if (typescriptLoader) {
            return typescriptLoader;
        }

        typescriptLoader = new Promise((resolve, reject) => {
            const script = document.createElement("script");

            script.src =
                "https://cdn.jsdelivr.net/npm/typescript@5.9.2/lib/typescript.js";

            script.onload = () => {
                if (window.ts) resolve(window.ts);
                else reject(new Error("TypeScript failed to initialize."));
            };

            script.onerror = () =>
                reject(
                    new Error(
                        "Could not download the TypeScript diagnostics engine."
                    )
                );

            document.head.appendChild(script);
        });

        return typescriptLoader;
    }

    function resolveWorkspaceImport(fromFile, specifier, fileSet) {
        if (!specifier.startsWith(".")) return true;

        const base = normalizePath(
            `${dirname(fromFile)}/${specifier}`
        );

        const possibilities = [
            base,
            base + ".ts",
            base + ".tsx",
            base + ".js",
            base + ".jsx",
            base + ".json",
            base + "/index.ts",
            base + "/index.tsx",
            base + "/index.js",
            base + "/index.jsx"
        ];

        return possibilities.some(path => fileSet.has(path));
    }

    async function runDiagnostics() {
        const modal = showModal(
            "Project Diagnostics",
            `<div class="ide-small">
                Loading diagnostics engine…
            </div>`
        );

        try {
            const files = await workspaceFiles();
            const fileSet = new Set(files.map(file => file.name));
            const ts = await loadTypeScript();
            const diagnostics = [];

            for (const file of files) {
                if (!/\.(ts|tsx|js|jsx)$/i.test(file.name)) {
                    continue;
                }

                if (typeof file.content !== "string") continue;

                const result = ts.transpileModule(file.content, {
                    fileName: file.name,
                    reportDiagnostics: true,

                    compilerOptions: {
                        target: ts.ScriptTarget.ES2022,
                        module: ts.ModuleKind.ESNext,
                        jsx: ts.JsxEmit.ReactJSX,
                        allowJs: true
                    }
                });

                for (const diag of result.diagnostics || []) {
                    const message = ts.flattenDiagnosticMessageText(
                        diag.messageText,
                        "\n"
                    );

                    const line =
                        diag.file && typeof diag.start === "number"
                            ? diag.file.getLineAndCharacterOfPosition(
                                  diag.start
                              ).line + 1
                            : 1;

                    diagnostics.push({
                        path: file.name,
                        line,
                        message,
                        kind: "syntax"
                    });
                }

                const importRegex =
                    /(?:import|export)[\s\S]*?\sfrom\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;

                let match;

                while ((match = importRegex.exec(file.content))) {
                    const spec = match[1] || match[2];

                    if (
                        spec &&
                        spec.startsWith(".") &&
                        !resolveWorkspaceImport(
                            file.name,
                            spec,
                            fileSet
                        )
                    ) {
                        diagnostics.push({
                            path: file.name,
                            line: lineFromOffset(
                                file.content,
                                match.index
                            ),
                            message: `Cannot resolve local import "${spec}"`,
                            kind: "import"
                        });
                    }
                }
            }

            if (!diagnostics.length) {
                modal.body.innerHTML = `
                    <div class="ide-good">
                        ✓ No syntax or broken local-import errors detected.
                    </div>

                    <p class="ide-small">
                        This checker catches TypeScript/JS syntax errors and
                        missing relative imports. It does not replace a full
                        npm/Vite type-check.
                    </p>
                `;

                return;
            }

            modal.body.innerHTML = `
                <div class="ide-warning">
                    ${diagnostics.length} issue${
                        diagnostics.length === 1 ? "" : "s"
                    } found
                </div>

                <div id="ideDiagnosticResults"></div>
            `;

            const box = $("ideDiagnosticResults");

            diagnostics.forEach(item => {
                const row = document.createElement("button");

                row.className = "ide-result";

                row.innerHTML = `
                    <div class="ide-path">
                        ${escapeHtml(item.path)}
                    </div>

                    <div class="ide-line">
                        Line ${item.line} · ${escapeHtml(item.kind)}
                    </div>

                    <div class="ide-error">
                        ${escapeHtml(item.message)}
                    </div>
                `;

                row.addEventListener("click", async () => {
                    closeModal();

                    await jumpToProjectResult(
                        item.path,
                        item.line
                    );
                });

                box.appendChild(row);
            });
        } catch (err) {
            modal.body.innerHTML = `
                <div class="ide-error">
                    ${escapeHtml(err.message)}
                </div>
            `;
        }
    }

    /* =====================================================
       GO TO DEFINITION / FIND REFERENCES
       ===================================================== */

    async function findIdentifierDefinitions(identifier) {
        if (!identifier) return [];

        const files = await workspaceFiles();
        const results = [];

        const escaped = identifier.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
        );

        const definitionRegex = new RegExp(
            `\\b(?:function|class|const|let|var|interface|type|enum)\\s+${escaped}\\b|\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?\\(`,
            "g"
        );

        for (const file of files) {
            if (!isTextFile(file.name)) continue;
            if (typeof file.content !== "string") continue;

            let match;

            while ((match = definitionRegex.exec(file.content))) {
                results.push({
                    path: file.name,
                    line: lineFromOffset(
                        file.content,
                        match.index
                    ),
                    preview:
                        file.content
                            .split("\n")[
                            lineFromOffset(file.content, match.index) -
                                1
                        ] || ""
                });
            }
        }

        return results;
    }

    async function goToDefinition() {
        const identifier = getSelectedWord();

        if (!identifier) {
            alert("Place the cursor on a function, variable, class, or type first.");
            return;
        }

        const results = await findIdentifierDefinitions(identifier);

        if (!results.length) {
            alert(`No definition found for "${identifier}".`);
            return;
        }

        if (results.length === 1) {
            await jumpToProjectResult(
                results[0].path,
                results[0].line
            );

            return;
        }

        showProjectResults(
            `Definitions: ${identifier}`,
            results
        );
    }

    async function findReferences() {
        const identifier = getSelectedWord();

        if (!identifier) {
            alert("Place the cursor on an identifier first.");
            return;
        }

        const files = await workspaceFiles();
        const results = [];

        const regex = new RegExp(
            `\\b${identifier.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
            )}\\b`,
            "g"
        );

        for (const file of files) {
            if (!isTextFile(file.name)) continue;
            if (typeof file.content !== "string") continue;

            let match;

            while ((match = regex.exec(file.content))) {
                const line = lineFromOffset(
                    file.content,
                    match.index
                );

                results.push({
                    path: file.name,
                    line,
                    preview:
                        file.content.split("\n")[line - 1]?.trim() ||
                        ""
                });
            }
        }

        showProjectResults(
            `References: ${identifier} (${results.length})`,
            results
        );
    }

    function showProjectResults(title, results) {
        const modal = showModal(title);

        if (!results.length) {
            modal.body.innerHTML =
                `<div class="ide-small">No results.</div>`;
            return;
        }

        results.slice(0, 500).forEach(result => {
            const row = document.createElement("button");

            row.className = "ide-result";

            row.innerHTML = `
                <div class="ide-path">
                    ${escapeHtml(result.path)}
                </div>

                <div class="ide-line">
                    Line ${result.line}
                </div>

                <div>
                    ${escapeHtml(result.preview)}
                </div>
            `;

            row.addEventListener("click", async () => {
                closeModal();

                await jumpToProjectResult(
                    result.path,
                    result.line
                );
            });

            modal.body.appendChild(row);
        });
    }

    /* =====================================================
       AUTO IMPORT
       ===================================================== */

    async function autoImportSelected() {
        const editor = $("editor");
        const current = editor?.dataset.filename;
        const identifier = getSelectedWord();

        if (!current || !identifier) {
            alert(
                "Open a file and place the cursor on the identifier you want to import."
            );
            return;
        }

        const files = await workspaceFiles();
        const candidates = [];

        const exportRegexes = [
            new RegExp(
                `\\bexport\\s+(?:async\\s+)?function\\s+${identifier}\\b`
            ),

            new RegExp(
                `\\bexport\\s+(?:const|let|var|class|interface|type|enum)\\s+${identifier}\\b`
            ),

            new RegExp(
                `\\bexport\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}`
            )
        ];

        for (const file of files) {
            if (file.name === current) continue;
            if (!/\.(ts|tsx|js|jsx)$/i.test(file.name)) continue;

            if (
                exportRegexes.some(regex =>
                    regex.test(file.content)
                )
            ) {
                candidates.push(file.name);
            }
        }

        if (!candidates.length) {
            alert(`No exported "${identifier}" was found.`);
            return;
        }

        let selected = candidates[0];

        if (candidates.length > 1) {
            const modal = showModal(
                `Import ${identifier}`,
                `<div id="ideImportCandidates"></div>`
            );

            const box = $("ideImportCandidates");

            candidates.forEach(path => {
                const row = document.createElement("button");

                row.className = "ide-result";
                row.textContent = path;

                row.addEventListener("click", () => {
                    selected = path;
                    closeModal();
                    insertImport();
                });

                box.appendChild(row);
            });

            return;
        }

        insertImport();

        function insertImport() {
            const importPath = relativePath(
                current,
                selected,
                true
            );

            const statement =
                `import { ${identifier} } from "${importPath}";\n`;

            if (
                editor.value.includes(
                    `{ ${identifier} } from "${importPath}"`
                ) ||
                editor.value.includes(
                    `{${identifier}} from "${importPath}"`
                )
            ) {
                alert(`${identifier} is already imported.`);
                return;
            }

            editor.value = statement + editor.value;

            editor.dispatchEvent(
                new Event("input", {
                    bubbles: true
                })
            );
        }
    }

    /* =====================================================
       RENAME FILE + UPDATE IMPORT REFERENCES
       ===================================================== */

    function resolveRelativeImport(fromFile, importPath) {
        return normalizePath(
            dirname(fromFile) + "/" + importPath
        );
    }

    function importPointsAtFile(
        importer,
        specifier,
        targetFile
    ) {
        if (!specifier.startsWith(".")) return false;

        const resolved = resolveRelativeImport(
            importer,
            specifier
        );

        const targetNoExt = withoutExtension(targetFile);
        const resolvedNoExt = withoutExtension(resolved);

        if (resolved === targetFile) return true;
        if (resolvedNoExt === targetNoExt) return true;

        if (
            targetFile.endsWith("/index.ts") ||
            targetFile.endsWith("/index.tsx") ||
            targetFile.endsWith("/index.js") ||
            targetFile.endsWith("/index.jsx")
        ) {
            const indexDir = dirname(targetFile);

            if (resolved === indexDir) return true;
        }

        return false;
    }

    async function renameCurrentFile() {
        const editor = $("editor");
        const oldPath = editor?.dataset.filename;

        if (!oldPath) {
            alert("Open the file you want to rename first.");
            return;
        }

        const newPathRaw = prompt(
            "New workspace path:",
            oldPath
        );

        if (!newPathRaw) return;

        const newPath = normalizePath(newPathRaw);

        if (!newPath || newPath === oldPath) return;

        const existing = await getWorkspaceFile(newPath);

        if (existing) {
            alert("A file already exists at that path.");
            return;
        }

        const files = await workspaceFiles();
        const original = files.find(
            file => file.name === oldPath
        );

        if (!original) {
            alert("Original file was not found.");
            return;
        }

        if (
            !confirm(
                `Rename:\n${oldPath}\n\nTo:\n${newPath}\n\nRelative imports will also be updated.`
            )
        ) {
            return;
        }

        await createHistorySnapshot(
            oldPath,
            original.content,
            "Before file rename"
        );

        for (const file of files) {
            if (
                !/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(
                    file.name
                )
            ) {
                continue;
            }

            let content = file.content;
            let changed = false;

            const importerPath =
                file.name === oldPath
                    ? newPath
                    : file.name;

            content = content.replace(
                /(["'])(\.{1,2}\/[^"'`\n]+)\1/g,
                (whole, quote, specifier) => {
                    if (
                        !importPointsAtFile(
                            file.name,
                            specifier,
                            oldPath
                        )
                    ) {
                        return whole;
                    }

                    const keepExtension =
                        /\.[a-z0-9]+$/i.test(specifier);

                    const replacement = relativePath(
                        importerPath,
                        newPath,
                        !keepExtension
                    );

                    changed = true;

                    return `${quote}${replacement}${quote}`;
                }
            );

            if (file.name === oldPath) {
                await writeWorkspaceFile(
                    newPath,
                    content
                );
            } else if (changed) {
                await createHistorySnapshot(
                    file.name,
                    file.content,
                    "Before import path rename"
                );

                await writeWorkspaceFile(
                    file.name,
                    content
                );
            }
        }

        await removeWorkspaceFileNoPrompt(oldPath);

        const tabIndex = openTabs.indexOf(oldPath);

        if (tabIndex >= 0) {
            openTabs[tabIndex] = newPath;
        }

        activeTab = newPath;

        await loadFiles();
        await openFile(newPath);
        renderTabs();

        alert("File renamed and matching relative imports were updated.");
    }

    /* =====================================================
       LOCAL HISTORY / CHECKPOINTS
       ===================================================== */

    function initHistoryDatabase() {
        if (historyDb) return Promise.resolve(historyDb);

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(HISTORY_DB, 1);

            request.onupgradeneeded = event => {
                const database = event.target.result;

                if (
                    !database.objectStoreNames.contains(
                        HISTORY_STORE
                    )
                ) {
                    const store = database.createObjectStore(
                        HISTORY_STORE,
                        {
                            keyPath: "id",
                            autoIncrement: true
                        }
                    );

                    store.createIndex(
                        "file",
                        "file",
                        {
                            unique: false
                        }
                    );
                }
            };

            request.onsuccess = event => {
                historyDb = event.target.result;
                resolve(historyDb);
            };

            request.onerror = () =>
                reject(
                    request.error ||
                        new Error(
                            "History database failed to open."
                        )
                );
        });
    }

    async function createHistorySnapshot(
        file,
        content,
        label = "Auto checkpoint"
    ) {
        if (!file || typeof content !== "string") return;

        const database = await initHistoryDatabase();

        await new Promise((resolve, reject) => {
            const tx = database.transaction(
                HISTORY_STORE,
                "readwrite"
            );

            tx.objectStore(HISTORY_STORE).add({
                file,
                content,
                label,
                createdAt: Date.now()
            });

            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });

        await trimHistory(file);
    }

    async function getHistory(file) {
        const database = await initHistoryDatabase();

        return await new Promise((resolve, reject) => {
            const tx = database.transaction(
                HISTORY_STORE,
                "readonly"
            );

            const index = tx
                .objectStore(HISTORY_STORE)
                .index("file");

            const request = index.getAll(file);

            request.onsuccess = () => {
                resolve(
                    (request.result || []).sort(
                        (a, b) => b.createdAt - a.createdAt
                    )
                );
            };

            request.onerror = () => reject(request.error);
        });
    }

    async function trimHistory(file) {
        const items = await getHistory(file);

        if (items.length <= MAX_HISTORY_PER_FILE) {
            return;
        }

        const database = await initHistoryDatabase();
        const remove = items.slice(MAX_HISTORY_PER_FILE);

        await new Promise((resolve, reject) => {
            const tx = database.transaction(
                HISTORY_STORE,
                "readwrite"
            );

            const store = tx.objectStore(HISTORY_STORE);

            remove.forEach(item => store.delete(item.id));

            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    async function showHistory() {
        const editor = $("editor");
        const file = editor?.dataset.filename;

        if (!file) {
            alert("Open a file first.");
            return;
        }

        const modal = showModal(
            `History · ${basename(file)}`,
            `<div class="ide-small">Loading checkpoints…</div>`
        );

        const history = await getHistory(file);

        modal.body.innerHTML = "";

        modal.footer.append(
            createButton(
                "Create Checkpoint",
                async () => {
                    await createHistorySnapshot(
                        file,
                        editor.value,
                        "Manual checkpoint"
                    );

                    closeModal();
                    await showHistory();
                },
                "btn btn-sm btn-success"
            )
        );

        if (!history.length) {
            modal.body.innerHTML = `
                <div class="ide-small">
                    No checkpoints yet.
                </div>
            `;

            return;
        }

        history.forEach(item => {
            const row = document.createElement("div");

            row.className = "ide-card";

            const when = new Date(
                item.createdAt
            ).toLocaleString();

            row.innerHTML = `
                <strong>${escapeHtml(item.label)}</strong>
                <div class="ide-small">${escapeHtml(when)}</div>
            `;

            const restore = createButton(
                "Restore",
                async () => {
                    if (
                        !confirm(
                            "Restore this checkpoint over the current file?"
                        )
                    ) {
                        return;
                    }

                    await createHistorySnapshot(
                        file,
                        editor.value,
                        "Before history restore"
                    );

                    await writeWorkspaceFile(
                        file,
                        item.content
                    );

                    closeModal();
                    await openFile(file);
                },
                "btn btn-sm btn-warning"
            );

            const view = createButton(
                "View",
                () => {
                    showModal(
                        `Checkpoint · ${basename(file)}`,
                        `
                            <textarea
                                class="ide-textarea"
                                readonly
                            >${escapeHtml(item.content)}</textarea>
                        `
                    );
                }
            );

            row.append(view, restore);
            modal.body.appendChild(row);
        });
    }

    function watchHistory() {
        const editor = $("editor");

        if (!editor) return;

        let previousFile = "";
        let previousContent = "";

        editor.addEventListener("focus", () => {
            previousFile = editor.dataset.filename || "";
            previousContent = editor.value;
        });

        editor.addEventListener("input", () => {
            clearTimeout(historyTimer);

            const file = editor.dataset.filename;

            if (!file) return;

            if (file !== previousFile) {
                previousFile = file;
                previousContent = editor.value;
                return;
            }

            historyTimer = setTimeout(async () => {
                if (
                    previousContent === editor.value ||
                    previousContent.length === 0
                ) {
                    previousContent = editor.value;
                    return;
                }

                try {
                    await createHistorySnapshot(
                        file,
                        previousContent,
                        "Auto checkpoint"
                    );

                    previousContent = editor.value;
                } catch (err) {
                    console.warn(
                        "History checkpoint failed",
                        err
                    );
                }
            }, 15000);
        });
    }

    /* =====================================================
       RIFTCITY SAVE DATA VIEWER
       ===================================================== */

    function getSafeLocalStorageKeys() {
        const blocked = new Set([
            "gh_token",
            "gh_sync_state_v2"
        ]);

        return Object.keys(localStorage).filter(
            key => !blocked.has(key)
        );
    }

    function showSaveDataViewer() {
        const keys = getSafeLocalStorageKeys();

        const modal = showModal(
            "Save Data Viewer",
            `
                <select id="ideSaveKey" class="ide-select">
                    <option value="">Choose localStorage key…</option>
                    ${keys
                        .map(
                            key =>
                                `<option value="${escapeHtml(
                                    key
                                )}">${escapeHtml(key)}</option>`
                        )
                        .join("")}
                </select>

                <textarea
                    id="ideSaveEditor"
                    class="ide-textarea"
                    placeholder="Stored data will appear here..."
                ></textarea>
            `
        );

        const select = $("ideSaveKey");
        const textarea = $("ideSaveEditor");

        select.addEventListener("change", () => {
            const key = select.value;

            if (!key) {
                textarea.value = "";
                return;
            }

            const raw = localStorage.getItem(key) || "";

            try {
                textarea.value = JSON.stringify(
                    JSON.parse(raw),
                    null,
                    2
                );
            } catch {
                textarea.value = raw;
            }
        });

        modal.footer.append(
            createButton(
                "Save Data",
                () => {
                    const key = select.value;

                    if (!key) {
                        alert("Choose a save key first.");
                        return;
                    }

                    let value = textarea.value;

                    try {
                        value = JSON.stringify(
                            JSON.parse(value)
                        );
                    } catch {}

                    localStorage.setItem(key, value);

                    alert(`Saved "${key}".`);
                },
                "btn btn-sm btn-success"
            )
        );
    }

    /* =====================================================
       RIFTCITY DEV PANEL
       ===================================================== */

    function findLikelyRiftCitySave() {
        const keys = getSafeLocalStorageKeys();

        const preferred =
            keys.find(key =>
                /rift|city|save|game|player/i.test(key)
            ) || keys[0];

        if (!preferred) return null;

        try {
            const parsed = JSON.parse(
                localStorage.getItem(preferred)
            );

            if (
                parsed &&
                typeof parsed === "object"
            ) {
                return {
                    key: preferred,
                    data: parsed
                };
            }
        } catch {}

        return null;
    }

    function deepFindNumericFields(
        object,
        wanted,
        path = "",
        results = []
    ) {
        if (!object || typeof object !== "object") {
            return results;
        }

        for (const [key, value] of Object.entries(object)) {
            const full = path
                ? `${path}.${key}`
                : key;

            if (
                typeof value === "number" &&
                wanted.some(name =>
                    key.toLowerCase().includes(name)
                )
            ) {
                results.push({
                    path: full,
                    key,
                    value
                });
            }

            if (
                value &&
                typeof value === "object" &&
                !Array.isArray(value)
            ) {
                deepFindNumericFields(
                    value,
                    wanted,
                    full,
                    results
                );
            }
        }

        return results;
    }

    function setDeep(object, path, value) {
        const parts = path.split(".");
        let target = object;

        for (let i = 0; i < parts.length - 1; i++) {
            if (
                !target[parts[i]] ||
                typeof target[parts[i]] !== "object"
            ) {
                target[parts[i]] = {};
            }

            target = target[parts[i]];
        }

        target[parts[parts.length - 1]] = value;
    }

    function showRiftCityDevPanel() {
        const save = findLikelyRiftCitySave();

        if (!save) {
            showModal(
                "RiftCity Dev Tools",
                `
                    <div class="ide-warning">
                        No JSON game save was detected in localStorage yet.
                    </div>

                    <p class="ide-small">
                        Run RiftCity once so its save exists, then reopen this panel.
                    </p>
                `
            );

            return;
        }

        const fields = deepFindNumericFields(
            save.data,
            [
                "money",
                "cash",
                "bank",
                "energy",
                "nerve",
                "health",
                "happiness",
                "level",
                "xp",
                "experience"
            ]
        );

        const modal = showModal(
            `RiftCity Dev · ${save.key}`,
            `
                <div class="ide-small">
                    Development-only save editor.
                    Changes affect the local browser save.
                </div>

                <div class="ide-grid" id="ideRiftFields"></div>
            `
        );

        const box = $("ideRiftFields");

        if (!fields.length) {
            box.innerHTML = `
                <div class="ide-small">
                    No common RiftCity numeric fields were automatically detected.
                    Use Save Data Viewer for the raw save.
                </div>
            `;
        }

        fields.slice(0, 40).forEach(field => {
            const card = document.createElement("div");

            card.className = "ide-card";

            card.innerHTML = `
                <div class="ide-small">
                    ${escapeHtml(field.path)}
                </div>

                <input
                    class="ide-input"
                    type="number"
                    step="any"
                    value="${field.value}"
                    data-rift-path="${escapeHtml(field.path)}"
                >
            `;

            box.appendChild(card);
        });

        modal.footer.append(
            createButton(
                "Apply Values",
                () => {
                    const updated = structuredClone
                        ? structuredClone(save.data)
                        : JSON.parse(
                              JSON.stringify(save.data)
                          );

                    box.querySelectorAll(
                        "[data-rift-path]"
                    ).forEach(input => {
                        const value = Number(input.value);

                        if (!Number.isNaN(value)) {
                            setDeep(
                                updated,
                                input.dataset.riftPath,
                                value
                            );
                        }
                    });

                    localStorage.setItem(
                        save.key,
                        JSON.stringify(updated)
                    );

                    alert(
                        "RiftCity save values updated. Reload the game/preview to apply them."
                    );
                },
                "btn btn-sm btn-success"
            )
        );
    }

    /* =====================================================
       PROJECT PREVIEW + CONSOLE
       ===================================================== */

    let esbuildLoader = null;

    async function loadEsbuild() {
        if (esbuildLoader) return esbuildLoader;

        esbuildLoader = (async () => {
            const esbuild = await import(
                "https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.9/esm/browser.min.js"
            );

            await esbuild.initialize({
                wasmURL:
                    "https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.9/esbuild.wasm",
                worker: true
            });

            return esbuild;
        })();

        return esbuildLoader;
    }

    function chooseProjectEntry(files) {
        const names = new Set(
            files.map(file => file.name)
        );

        const candidates = [
            "src/main.tsx",
            "src/main.jsx",
            "src/main.ts",
            "src/main.js",
            "src/index.tsx",
            "src/index.jsx",
            "src/index.ts",
            "src/index.js",
            "main.tsx",
            "main.jsx",
            "main.ts",
            "main.js",
            "index.tsx",
            "index.jsx",
            "index.ts",
            "index.js"
        ];

        return candidates.find(name => names.has(name)) || "";
    }

    function createPreviewHtml(scriptText, cssText = "") {
        const consoleBridge = `
            <script>
            (() => {
                const send = (type, args) => {
                    try {
                        parent.postMessage({
                            source: "riftcity-preview",
                            type,
                            args: args.map(value => {
                                try {
                                    if (typeof value === "string") return value;
                                    return JSON.stringify(value);
                                } catch {
                                    return String(value);
                                }
                            })
                        }, "*");
                    } catch {}
                };

                ["log", "warn", "error", "info"].forEach(type => {
                    const original = console[type];

                    console[type] = (...args) => {
                        send(type, args);
                        original.apply(console, args);
                    };
                });

                window.addEventListener("error", event => {
                    send("error", [
                        event.message,
                        event.filename + ":" + event.lineno
                    ]);
                });

                window.addEventListener("unhandledrejection", event => {
                    send("error", [
                        "Unhandled promise rejection:",
                        String(event.reason)
                    ]);
                });
            })();
            <\/script>
        `;

        return `
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta
                    name="viewport"
                    content="width=device-width,initial-scale=1"
                >
                <style>
                    html,body,#root {
                        min-height:100%;
                        margin:0;
                    }

                    ${cssText || ""}
                </style>
            </head>
            <body>
                <div id="root"></div>

                ${consoleBridge}

                <script type="module">
                    ${scriptText}
                <\/script>
            </body>
            </html>
        `;
    }

    async function previewCurrentHtml(files, htmlFile) {
        const modal = showPreviewModal();

        modal.body.innerHTML = `
            <div class="ide-preview-wrap">
                <iframe
                    id="idePreviewFrame"
                    class="ide-preview-frame"
                    sandbox="allow-scripts allow-forms allow-modals allow-same-origin"
                ></iframe>

                <div
                    id="idePreviewConsole"
                    class="ide-console"
                ></div>
            </div>
        `;

        previewFrame = $("idePreviewFrame");

        const html = htmlFile.content;

        previewFrame.srcdoc = html;
    }

    function showPreviewModal() {
        previewConsole = [];

        return showModal(
            "RiftCity Preview",
            `<div class="ide-small">
                Building project…
            </div>`
        );
    }

    async function previewProject() {
        const modal = showPreviewModal();

        try {
            const files = await workspaceFiles();
            const entry = chooseProjectEntry(files);

            if (!entry) {
                const htmlFile =
                    files.find(
                        file =>
                            file.name === "index.html"
                    ) ||
                    files.find(file =>
                        /\.html?$/i.test(file.name)
                    );

                if (htmlFile) {
                    await previewCurrentHtml(
                        files,
                        htmlFile
                    );

                    return;
                }

                throw new Error(
                    "Could not find src/main.tsx, src/main.jsx, main.js, or index.html."
                );
            }

            modal.body.innerHTML = `
                <div class="ide-small">
                    Loading browser bundler…
                </div>
            `;

            const esbuild = await loadEsbuild();

            const fileMap = new Map(
                files.map(file => [
                    normalizePath(file.name),
                    file.content
                ])
            );

            const plugin = {
                name: "workspace-files",

                setup(build) {
                    build.onResolve(
                        {
                            filter: /.*/
                        },
                        args => {
                            if (
                                args.path.startsWith(
                                    "http://"
                                ) ||
                                args.path.startsWith(
                                    "https://"
                                )
                            ) {
                                return {
                                    path: args.path,
                                    external: true
                                };
                            }

                            if (
                                !args.path.startsWith(".") &&
                                !args.path.startsWith("/")
                            ) {
                                return {
                                    path:
                                        "https://esm.sh/" +
                                        args.path,
                                    external: true
                                };
                            }

                            const importer =
                                args.importer || entry;

                            const raw = args.path.startsWith("/")
                                ? args.path.slice(1)
                                : normalizePath(
                                      dirname(importer) +
                                          "/" +
                                          args.path
                                  );

                            const candidates = [
                                raw,
                                raw + ".ts",
                                raw + ".tsx",
                                raw + ".js",
                                raw + ".jsx",
                                raw + ".json",
                                raw + ".css",
                                raw + "/index.ts",
                                raw + "/index.tsx",
                                raw + "/index.js",
                                raw + "/index.jsx"
                            ];

                            const resolved =
                                candidates.find(path =>
                                    fileMap.has(path)
                                );

                            if (!resolved) {
                                return {
                                    errors: [
                                        {
                                            text:
                                                `Workspace module not found: ` +
                                                args.path
                                        }
                                    ]
                                };
                            }

                            return {
                                path: resolved,
                                namespace: "workspace"
                            };
                        }
                    );

                    build.onLoad(
                        {
                            filter: /.*/,
                            namespace: "workspace"
                        },
                        args => {
                            const content =
                                fileMap.get(args.path);

                            const ext =
                                extname(args.path)
                                    .slice(1)
                                    .toLowerCase() || "js";

                            let loader = ext;

                            if (ext === "mjs") loader = "js";
                            if (ext === "cjs") loader = "js";

                            return {
                                contents: content,
                                loader
                            };
                        }
                    );
                }
            };

            const result = await esbuild.build({
                entryPoints: [entry],
                bundle: true,
                write: false,
                format: "esm",
                platform: "browser",
                target: ["es2020"],
                jsx: "automatic",
                plugins: [plugin],
                sourcemap: "inline",
                logLevel: "silent"
            });

            const jsOutput = result.outputFiles.find(
                file =>
                    file.path.endsWith(".js") ||
                    !file.path.endsWith(".css")
            );

            const cssOutput = result.outputFiles.find(
                file => file.path.endsWith(".css")
            );

            if (!jsOutput) {
                throw new Error(
                    "Bundler did not produce JavaScript output."
                );
            }

            modal.body.innerHTML = `
                <div class="ide-preview-wrap">
                    <iframe
                        id="idePreviewFrame"
                        class="ide-preview-frame"
                        sandbox="allow-scripts allow-forms allow-modals allow-same-origin"
                    ></iframe>

                    <div
                        id="idePreviewConsole"
                        class="ide-console"
                    ></div>
                </div>
            `;

            previewFrame = $("idePreviewFrame");

            previewFrame.srcdoc = createPreviewHtml(
                jsOutput.text,
                cssOutput?.text || ""
            );
        } catch (err) {
            console.error(err);

            modal.body.innerHTML = `
                <div class="ide-error">
                    Preview failed:
                    ${escapeHtml(err.message)}
                </div>

                <p class="ide-small">
                    The preview runs entirely in Safari/Chrome and bundles
                    workspace TypeScript/TSX in-browser. Projects that depend
                    on Node-only Vite plugins or server APIs may still need
                    their normal desktop build environment.
                </p>
            `;
        }
    }

    function receivePreviewConsole(event) {
        const data = event.data;

        if (
            !data ||
            data.source !== "riftcity-preview"
        ) {
            return;
        }

        const consoleBox = $("idePreviewConsole");

        if (!consoleBox) return;

        const type = data.type || "log";
        const text = (data.args || []).join(" ");

        previewConsole.push({
            type,
            text
        });

        const line = document.createElement("div");

        line.className =
            type === "error"
                ? "ide-console-error"
                : type === "warn"
                ? "ide-console-warn"
                : "ide-console-log";

        line.textContent =
            `[${type.toUpperCase()}] ${text}`;

        consoleBox.appendChild(line);
        consoleBox.scrollTop =
            consoleBox.scrollHeight;
    }

    /* =====================================================
       SAVE / HISTORY HOOKS
       ===================================================== */

    function hookSaveButton() {
        const button = $("saveLocalBtn");

        if (!button) return;

        button.addEventListener(
            "click",
            async () => {
                const editor = $("editor");
                const file =
                    editor?.dataset.filename;

                if (!file) return;

                try {
                    const stored =
                        await getWorkspaceFile(file);

                    if (
                        stored &&
                        stored.content !== editor.value
                    ) {
                        await createHistorySnapshot(
                            file,
                            stored.content,
                            "Before manual save"
                        );
                    }
                } catch (err) {
                    console.warn(
                        "Unable to create save checkpoint",
                        err
                    );
                }
            },
            true
        );
    }

    /* =====================================================
       KEYBOARD SHORTCUTS
       ===================================================== */

    function bindIdeShortcuts() {
        document.addEventListener("keydown", event => {
            const mod =
                event.ctrlKey || event.metaKey;

            if (!mod) return;

            if (
                event.shiftKey &&
                event.key.toLowerCase() === "f"
            ) {
                event.preventDefault();
                showProjectSearch();
            }

            if (
                event.shiftKey &&
                event.key.toLowerCase() === "d"
            ) {
                event.preventDefault();
                showGitDiff();
            }

            if (
                event.key.toLowerCase() === "p" &&
                event.shiftKey
            ) {
                event.preventDefault();
                previewProject();
            }
        });
    }

    /* =====================================================
       STARTUP
       ===================================================== */

    function initializeIDE() {
        injectStyles();
        createModal();
        injectToolbar();
        injectTabs();
        setupMobileEditorActions();
        hookCoreCloseButton();

        watchActiveFile();
        watchHistory();
        hookSaveButton();
        interceptPushChanges();
        bindIdeShortcuts();

        window.addEventListener(
            "message",
            receivePreviewConsole
        );

        registerCurrentFile();

        console.info(
            `${IDE_VERSION} ready`
        );
    }

    if (document.readyState === "loading") {
        document.addEventListener(
            "DOMContentLoaded",
            initializeIDE,
            {
                once: true
            }
        );
    } else {
        initializeIDE();
    }
})();