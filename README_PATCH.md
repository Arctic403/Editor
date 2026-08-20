# v8 Git Sync Clean Checkout

- Pull Repo now behaves like a clean Git checkout instead of overlaying files onto old IndexedDB contents.
- All remote blobs are downloaded first; the local workspace is replaced only after every download succeeds.
- The replacement happens in one IndexedDB transaction, so a failed pull leaves the old workspace untouched.
- Local-only leftovers from an older repo no longer appear as false "new" files in Push Changes.
- Pull downloads up to 5 blobs concurrently.
- The open editor is refreshed or cleared after a workspace replacement.
- Push Changes still uses the v7 baseline/change detection and one-commit Git Data API flow.

After deploying v8, do one fresh Pull Repo. Then create a single test file; Push Changes should report exactly **1 new** file.
