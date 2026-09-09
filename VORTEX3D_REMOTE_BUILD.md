# Vortex3D remote build from Editor

When `Arctic403/Vortex3d` is the selected repository, the Editor shows **🛠 Vortex Build**.

The button performs the full local-controller flow without using a Vortex3D GitHub Action:

1. Saves the active local file and reads the complete browser workspace from IndexedDB.
2. Refuses obviously partial workspaces so a build cannot accidentally replace most of the private source tree.
3. Pushes the local workspace to the selected private Vortex3D branch as one Git commit.
4. Explicitly excludes/deletes `.github/workflows/` so Vortex3D remains an Actions-free source repository even if an old local workspace still contains stale workflow files.
5. Directly `workflow_dispatch`es `Arctic403/VTXBuilder/.github/workflows/vortex3d-worker.yml` with the exact source SHA and a unique Editor client id.
6. Polls private Vortex3D releases for that exact source SHA + client id.
7. On success, automatically downloads `Vortex3D-verification-<sha>.zip` back to the device and exposes a separate Universal APK download button.
8. On failure, automatically downloads the private worker failure-diagnostics ZIP when available.

## Token permissions

The PAT entered in the Editor stays in the browser's existing GitHub token field. For this flow it needs:

- `Arctic403/Vortex3d`: **Contents read/write**.
- `Arctic403/VTXBuilder`: **Actions read/write**.

The Editor never needs `VTXBuilder` source write access and never uploads private Vortex3D source into the public VTXBuilder repository. VTXBuilder checks out the exact private source commit ephemerally with its own restricted `VORTEX_PRIVATE_TOKEN` secret.

## Result ZIP

The verification ZIP returned by VTXBuilder includes the APK verification payload and full verification evidence. The private release also exposes the split and universal APKs separately.
