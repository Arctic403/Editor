# RiftOS remote build from Editor

When `Arctic403/RiftOS` is the selected repository, the Editor shows **🛠 Rift Build**.

The button mirrors the Vortex3D/VTXBuilder private-source build architecture:

1. Saves the active local file and reads the complete browser workspace from IndexedDB.
2. Refuses obviously partial workspaces so a build cannot accidentally replace most of the private source tree.
3. Pushes only changed source blobs to the selected private RiftOS branch as one Git commit.
4. Explicitly excludes/deletes `.github/workflows/` so RiftOS remains an Actions-free private source repository.
5. Directly `workflow_dispatch`es `Arctic403/Riftos-builder/.github/workflows/riftos-worker.yml` with the exact source SHA and a unique Editor client id.
6. The public builder checks out that exact private source commit ephemerally, builds and verifies the Android APK, and uploads no public Actions artifact.
7. The builder returns success as a private RiftOS prerelease containing the APK, verification ZIP, manifest, provenance, and checksums. Failure diagnostics are also returned privately.
8. The Editor polls private RiftOS releases for the exact source SHA + client id and exposes explicit download buttons when the matching result arrives.

## Token permissions

The PAT entered in the Editor stays in the browser's existing GitHub token field. For this flow it needs:

- `Arctic403/RiftOS`: **Contents read/write**.
- `Arctic403/Riftos-builder`: **Actions read/write**.

The Editor does not need source write access to the public builder.

## Builder secret

`Arctic403/Riftos-builder` needs one repository Actions secret:

- `RIFTOS_PRIVATE_TOKEN` — fine-grained PAT restricted to `Arctic403/RiftOS` with **Contents read/write**.

This secret lets the public worker read the exact private source commit and write the resulting prerelease/assets back to the private RiftOS repository. Private source is never committed into the public builder repository.

## Signing

The worker can use RiftOS's existing alpha/debug keystore from the private source tree. Optional production signing uses these builder secrets:

- `RIFTOS_KEYSTORE_B64`
- `RIFTOS_KEYSTORE_PASSWORD`
- `RIFTOS_KEY_ALIAS`
- `RIFTOS_KEY_PASSWORD`

## Returned artifacts

A successful private RiftOS prerelease contains:

- `RiftOS-Android-debug.apk`
- `RiftOS-verification-<sha>.zip`
- `build-manifest.json`
- `provenance.txt`
- `sha256sums.txt`

The public builder intentionally does not use `actions/upload-artifact` for private RiftOS builds.
