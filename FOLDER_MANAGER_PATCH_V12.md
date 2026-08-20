# Folder Manager Patch v12

- Added persistent real folders in IndexedDB (`folders` store, schema v2).
- Added **+ New Folder**.
- Added **Import Folder** using relative paths where the browser supports directory picking.
- ZIP import now recreates the ZIP directory tree and retains empty folders.
- Files and folders are draggable into another folder.
- Added an explicit **Workspace Root** drop target so items can be dragged back out of nested folders.
- Added a `↪` move fallback for touch/iPhone/Safari where native HTML drag-and-drop is unreliable.
- Moving a folder moves every nested file/subfolder and blocks moving a folder into itself/its descendants.
- Open editor paths/tabs update after file/folder moves.
- New files created with nested paths persist their parent folders.
- ZIP export now writes persistent folders as well as files, preserving empty folders.
- Added path normalization and ignores macOS `__MACOSX` ZIP metadata.
