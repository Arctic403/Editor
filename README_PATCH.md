# Patch Notes — Git Sync v7

- Keeps Safari-safe IndexedDB database and v6 folder-tree fixes.
- Binds the local workspace to the repo/branch after a successful pull.
- Saves a per-file sync baseline (GitHub blob SHA, local content hash, file mode).
- Detects modified, new, deleted, moved, and renamed files; unchanged files are skipped.
- Push Changes uses GitHub Git Data API to create one commit for the entire change set.
- Uploads changed blobs with a safe concurrency limit of 5 instead of pushing every file sequentially.
- Checks the remote branch head before pushing and stops on remote changes to avoid overwriting newer work.
- Single-file Push uses the saved baseline when available and updates sync state after success.
- Adds visible repo/branch/change counts and push progress.
- Script renamed to `app-safari-v7.js` to avoid stale Safari cache.

A successful pull is required once for the selected repo/branch before optimized **Push Changes** can be used.
