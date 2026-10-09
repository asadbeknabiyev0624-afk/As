# JARVIS Android client

The APK connects to the owner's JARVIS server on their Windows PC over HTTPS. It does not download or run an AI model on the phone. Set up the Windows app, Ollama, a private HTTPS connection such as Tailscale Serve, and the server access key first. The native **Connection** button saves the server origin; enter the key in the web app's unlock screen.

Android 8.0 or later is required. This native Java app has no third-party Java dependencies or architecture-specific native libraries. It uses the same server-hosted UI as the desktop app. Android voice input and text-to-speech are exposed to that UI as `window.JarvisAndroid`; microphone permission is requested only when the microphone is tapped. Voice stops when the app leaves the foreground. Recognition prefers an installed offline language, but the phone's speech provider may use its own network service.

The client refuses HTTP, mixed content, invalid HTTPS certificates, and cross-origin WebView resources. External HTTP(S) page links open in the device browser. Reminders work while the web app is open; this APK has no background alarm or always-on listening service.

## Build

On a Linux x86-64 build machine, from the repository root:

```sh
bash scripts/build-android.sh
```

The script provisions Android SDK platform 35/build tools 35 and a verified JDK 21 in a sibling `.jarvis-android-tools` directory. It checks downloads against Google's published repository checksums and the JDK publisher's SHA-256 checksum. If an existing developer JDK is supplied through `JAVA_HOME`, it is reused. SDK and JDK licenses apply to the downloaded build tools; the JDK is not redistributed in the APK.

The default artifact is the sibling `scratch/JARVIS-Android.apk`. Set `JARVIS_ANDROID_TOOLS` or `JARVIS_ANDROID_OUTPUT` to override these locations. The script verifies APK signing and zip alignment before reporting success.

This is an installable **development-signed** APK for personal sideloading, not a Play Store release. The private signing key and random password are created outside the repository under `.jarvis-android-tools/development-signing`; do not commit or distribute them. Retain that directory to sign future updates with the same key. A different signing key cannot update an already installed copy without uninstalling it first.

Actual microphone/TTS availability, private connectivity, and device installation must be checked on the user's Android phone. APK compilation, manifest permissions, signing, and alignment have been verified in the cloud build environment.
