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
