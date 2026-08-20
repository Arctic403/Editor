# GitHub Pull/Push Patch

Patched GitHub integration to make repository synchronization explicit and reliable.

## Changes
- Repository selection now only loads branches; it no longer races an automatic import.
- Added an explicit **Pull Repo** button.
- Saved/default branch selection is restored safely.
- Pull resolves selected branch -> commit -> tree SHA before reading the repository tree.
- GitHub errors now include HTTP status and API message where available.
- Git blobs are decoded from the documented Base64 JSON response.
- UTF-8 text remains editable; binary files are preserved as Base64-backed workspace files.
- Binary files pushed back to GitHub are decoded correctly instead of pushing the data-URL wrapper.
- ZIP export now restores Base64-backed binary files to their original bytes.
- Push checks require a selected branch and URL-encode repository file paths safely.
- Added current GitHub REST API headers/version.


## Safari v2 cache/IndexedDB patch
- Renamed the application script to `app-safari-v2.js` and changed `index.html` to reference the new filename, forcing Safari to stop using a cached legacy `app.js`.
- Added asset version query strings.
- Added an application build marker in the console.
- All remaining workspace IndexedDB operations now obtain a live database through `getDatabase()` instead of directly assuming the global `db` connection is ready.
- Added Safari page-cache IndexedDB recovery via `pageshow`.
- GitHub pulls validate/open IndexedDB before downloading files.


## Safari IndexedDB version fix (v3)
- Removed the hard-coded `indexedDB.open("LocalWorkspaceDB", 3)` call.
- The app now opens the database at whatever version already exists in Safari.
- If the `files` object store is missing, it upgrades from the database's actual current version.
- This fixes Safari `VersionError: An attempt was made to open a database using a lower version than the existing version`.
- JavaScript asset renamed to `app-safari-v3.js` to force a fresh Safari load.
