# Universal Android Single Player

The Editor's **🎮 Single Player** button targets the Android-first local test workflow used by Fallpoint-style projects instead of the legacy Ironvale browser/WASM preview.

## Required project contract

The current workspace must contain a normal Android Gradle/NDK app, including:

- `settings.gradle` or `settings.gradle.kts`
- `app/build.gradle` or `app/build.gradle.kts`
- `app/src/main/AndroidManifest.xml`
- `app/src/main/cpp/CMakeLists.txt`
- both `armeabi-v7a` and `arm64-v8a` in the app ABI configuration

The validator also warns when it cannot see obvious CMake/external-native-build wiring.

## Three APK test outputs

**BUILD 3 APKS** snapshots the current local Editor workspace to an isolated temporary GitHub branch, adds the debug-only local backend state, and runs the Android SDK/NDK build without modifying the selected game branch.

Every successful build produces three independently downloadable debug APKs:

- `<repo>-arm32-debug.apk` — `armeabi-v7a` only
- `<repo>-arm64-debug.apk` — `arm64-v8a` only
- `<repo>-universal-debug.apk` — both `armeabi-v7a` and `arm64-v8a`

The universal APK is built first. The ARM32 and ARM64 packages are derived from that exact binary, then zip-aligned and re-signed with the same Android debug key. The build verifies the ABI contents and APK signatures before the Editor exposes the download buttons.

The temporary build branch is deleted after the Editor has loaded all three APKs into the current browser session.

## Local single-player state

The test build receives:

- `.fallpoint-local-test/state.json`
- `app/src/debug/assets/fallpoint-local-backend.json`
- `app/src/debug/java/<namespace>/local/LocalBackendStore.java`

The device-local state is also kept separately in Editor Cache Storage and can be exported, imported or reset without changing the source workspace. Production backend services are not contacted by this Single Player path.

## Build boundary

The browser/PWA does not execute Gradle or the NDK itself. The Editor creates the isolated build snapshot, GitHub Actions performs the Android compilation and verification, and the finished APK bytes are returned to the Editor for download to the Android device.
