# Safari / Folder Tree v6 patch

- Folder taps no longer call `loadFiles()` or rebuild the tree.
- Folder expand/collapse now toggles the existing DOM node in place.
- Removed inline `onclick` markup from file/folder tree rows and replaced it with event listeners.
- Added a short duplicate-tap guard for iOS/Safari synthesized clicks.
- Added `touch-action: manipulation` for tree rows.
- Expanded folder state is still preserved when the tree later refreshes for real file operations.
- Script renamed to `app-safari-v6.js` to force Safari to load the new code.
- Existing GitHub and Safari-safe IndexedDB fixes are preserved.
