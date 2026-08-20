# Mobile Workspace Editor — audit patch

Patched the workspace editor after a static control/logic audit.

## Fixed
- Wired the previously dead **Connect GitHub** button.
- Added GitHub config persistence for repository/branch.
- Added validation for `owner/repository`.
- Fixed GitHub UTF-8 decoding/encoding for non-ASCII files.
- Added GitHub request error details and safer async error handling.
- Fixed mobile **Git** button so it opens the GitHub settings instead of unexpectedly pushing.
- Added proper file-tab close buttons.
- Removed closed files from the tab/history state.
- Made undo/redo correctly return to a clean state when content matches the last saved version.
- Fixed search index reset when the search query changes.
- Added line-number bounds checking.
- Added ZIP/file import cleanup so the same file input can be selected repeatedly.
- Added ZIP export/download DOM cleanup.
- Added missing IndexedDB transaction abort/error handling.
- Added keyboard accessibility for folder rows.
- Added safer delete/open/create/import/export error handling.
- Added modal backdrop close behavior.
- Kept `style.css` synchronized with `app.css` for compatibility.

## Validation
- `app.js` passes Node syntax checking.
- Every interactive button/input in `index.html` is wired; `replaceInput` intentionally needs no event handler because it is read by the Replace actions.
