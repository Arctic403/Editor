# Universal Android Single Player

The Editor's **🎮 Single Player** button now targets the Android-first local test workflow used by Fallpoint-style projects instead of the legacy Ironvale browser/WASM preview.

## Required project contract

The current workspace must contain a normal Android Gradle/NDK app, including:

- `settings.gradle` or `settings.gradle.kts`
- `app/build.gradle` or `app/build.gradle.kts`
- `app/src/main/AndroidManifest.xml`
- `app/src/main/cpp/CMakeLists.txt`
- both `armeabi-v7a` and `arm64-v8a` in the app ABI configuration

The validator also warns when it cannot see obvious CMake/external-native-build wiring.

## What PREPARE LOCAL ANDROID ZIP does

The Editor reads the current IndexedDB workspace, omits local build output, secrets, keystores and `local.properties`, validates the universal ABI contract, and exports a ZIP whose root is the Gradle project root.

The exported test package adds only debug/local-test material:

- `.fallpoint-local-test/manifest.json`
- `.fallpoint-local-test/state.json`
- `app/src/debug/assets/fallpoint-local-backend.json`
- `app/src/debug/java/<namespace>/local/LocalBackendStore.java`
- `tools/build-local-android.sh`

The device-local state is kept separately in Editor Cache Storage and can be exported, imported or reset without changing the source workspace.

## Build boundary

The browser Editor does **not** pretend to run Gradle, the Android SDK or the NDK. It prepares a buildable local package. Build that package with the Android toolchain installed on the device/machine. The generated helper runs `:app:assembleDebug` and, when the project contains `scripts/verify_universal_apk.py`, verifies that the resulting APK contains both ARM ABIs.

Production backend services are not contacted by this Single Player path.
