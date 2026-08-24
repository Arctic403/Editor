# Editor v11 Immersive Audit Patch

- Editor view is now an immersive full-screen workspace whenever a file is open.
- Removed permanent editor action bars, breadcrumbs, region bar, symbol bar, and legacy tab strips from the editor view.
- Added one small floating dock: Explorer, current file/Open Files, Files count, Tools, Close.
- Open Files contains only files currently open in the session and each close button is synchronized with the core editor.
- Core `openFile()` now resolves only after IndexedDB finishes loading the file, fixing tab switching races.
- Core editor now emits explicit file-opened/file-closed/view-changed events so tab state cannot drift from `data-filename`.
- Closing the last open file returns to Explorer.
- Search, Regions, and Symbols are temporary overlays opened from Tools rather than permanent rows.
- Preserves Git pull/push, Git sync baseline, Safari IndexedDB, folder tree, project search, Git diff, diagnostics, preview, history, rename/import helper and RiftCity dev tools.
- Removed obsolete historical app/IDE JavaScript copies from the deployment package to prevent accidental loading/caching confusion.

## Codex integration (2026-08-24)

- Added `codex-panel.js` to the editor UI.
- Added `codex-backend/` with a JavaScript Node bridge using `@openai/codex-sdk`.
- The editor sends a temporary copy of workspace text files to the bridge.
- Codex edits only the temporary server-side workspace and returns proposed changes.
- Changes are written into the editor's IndexedDB workspace only after **Apply**.
- Existing GitHub Push remains a separate/manual step.
- `OPENAI_API_KEY` belongs only on the bridge server; never put it in the browser build.
- See `CODEX_SETUP.txt` for deployment/configuration.
