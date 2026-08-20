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
