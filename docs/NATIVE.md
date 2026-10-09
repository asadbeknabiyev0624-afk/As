# JARVIS EXE + APK

Windows uchun **JARVIS-Windows.exe** faylini oching. Android uchun **JARVIS-Android.apk** faylini o‘rnating. Telefonda AI ishlashi uchun kompyuteringizda JARVIS ochiq va internetga ulangan bo‘lishi kerak.

| Device | Download | Requirement |
| --- | --- | --- |
| Computer | `JARVIS-Windows.exe` | Windows 10 or 11, 64-bit x64 |
| Phone | `JARVIS-Android.apk` | Android 8 or newer |

## Start on Windows

1. Save `JARVIS-Windows.exe` in a folder you control, then double-click it. This portable app includes its server and web interface; you do not need Node.js, npm, or a terminal to launch it. It is an unsigned personal development build, so Windows may show an unknown-publisher notice.
2. Open **Settings → Desktop & Android → Install Ollama**. Install Ollama from the official Windows download page that opens.
3. Close and reopen JARVIS. It reuses an existing local Ollama server or starts the installed Ollama command.
4. Choose **Download free AI**. Keep JARVIS open while the `qwen2.5:1.5b` model downloads, about 1 GB. Refresh the AI connection in Settings when the download finishes.
5. Add your name and preferences in Settings, then send a message.

The AI runs on your own computer without a paid AI API or subscription. Initial installation and model downloading need internet access; local AI replies can work afterward without internet. Notes and tasks work even before the model is ready. Larger models are optional and require more computer memory.

## Install and connect Android

1. Transfer `JARVIS-Android.apk` to your phone and open it. If Android asks, allow installation from the browser or file manager you are using, then complete installation.
2. Install [Tailscale](https://tailscale.com/download) on Windows and Android. Sign both devices into the same private network. Check the current personal-plan options when creating your account.
3. Keep the Windows JARVIS app open. In PowerShell on the computer, run:

   ```powershell
   tailscale serve --bg http://127.0.0.1:3001
   ```

   Follow any prompt to enable private HTTPS. Copy the actual `https://` address that Tailscale prints.
4. Open the JARVIS Android app and enter that HTTPS address. Keep Tailscale connected on the phone.
5. On Windows, choose **Settings → Desktop & Android → Copy phone key**, or use the **JARVIS → Connect Android phone** menu. Transfer that key privately and enter it on the phone's unlock screen.

Use **Tailscale Serve** for this private connection. Tailscale Funnel publishes a service publicly and is not needed here. The Android APK connects to the AI on your computer; it does not include an AI model. Your PC must remain awake, online, and running JARVIS for phone conversations and updates, including when you are away from home.

The APK is signed with a development key for this personal build. It is not a Play Store release. Keeping the same signing key allows future APK updates without uninstalling the app.

## Voice, memory, and access

Tap the microphone to dictate, review the text, then send it. Allow microphone permission when Android asks. Turn on the speaker button for spoken replies. Android uses its installed speech recognition and text-to-speech services; available languages, offline support, and voices depend on those services. Windows voice support depends on Chromium and installed voices.

This version uses push-to-talk. It does not listen continuously or deliver scheduled alarms after the app closes. Task notifications require the app to remain open and connected.

Conversations, memories, and tasks live in the Windows app's user-data directory, with app data under its `data` folder. The phone-access key is generated automatically for each installation and saved in `connection.json`; Windows encrypts it using the signed-in user's DPAPI key. The desktop app unlocks its own trusted local interface automatically. Phone access requires the key. Keep the key private and avoid deleting the app's user-data folder if you want to retain your memories and connection.

The companion server listens at `127.0.0.1:3001` and requires its key for API access. Ollama stays local. Tailscale supplies the private HTTPS connection to the phone; opening a public router port is unnecessary.

## If setup stalls

- **Model needs setup:** Finish installing Ollama, reopen JARVIS, choose **Download free AI**, then refresh the model connection. Try the download again if it reports failure.
- **Port 3001 is already in use:** Close the other JARVIS server or application using that port, then reopen the EXE.
- **Phone cannot connect:** Check that the PC is awake, JARVIS is open, and Tailscale is connected on both devices. Use the HTTPS address printed by `tailscale serve`.
- **Phone cannot unlock:** Copy the key from the currently running Windows app and enter that exact key on the phone.
- **Microphone is unavailable:** Check microphone permission and the installed speech service, or type your message.

## Rebuild from source

Use Node.js 24 for development and native builds. The commands below rebuild the files on Linux; running the downloaded EXE or APK does not require these tools. Run them from the repository directory. Cloud cache paths stay under `/workspace`:

```bash
export XDG_CACHE_HOME=/workspace/.jarvis-desktop-tools/cache
export ELECTRON_CACHE=/workspace/.electron-cache
export ELECTRON_BUILDER_CACHE=/workspace/.electron-builder-cache
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm ci --cache /workspace/.cache/npm
NODE_USE_ENV_PROXY=1 electron_config_cache="$ELECTRON_CACHE" \
  node node_modules/electron/install.js
npm test
npm run package:windows -- -c.electronDownload.cache="$ELECTRON_CACHE"
npm run package:android
```

Electron 44's npm package does not run a postinstall download automatically. The explicit `install.js` command installs the development runtime and verifies its download. `NODE_USE_ENV_PROXY=1` uses the proxy already configured in the cloud environment. The builder cache option selects the same cache for Windows packaging. On another machine, replace the `/workspace` paths with writable cache directories.

The Windows portable output is `release/windows/JARVIS-0.1.0-Windows-x64.exe`; the download copy is named `JARVIS-Windows.exe`. Windows packaging uses `win.signAndEditExecutable: false`, so the Linux build does not need Wine or a signing certificate.

The Android build script provisions checksum-verified SDK/JDK tools as needed and produces `../scratch/JARVIS-Android.apk` by default. It requires Bash, curl, unzip, zip, tar, and checksum utilities. `JARVIS_ANDROID_TOOLS` and `JARVIS_ANDROID_OUTPUT` can override its tool directory and output path. The private development signing key and password remain outside the repository in the tool directory; do not include them in ZIPs or publish them. The build script verifies the APK signature and ZIP alignment before completion.

Package-format and signature checks do not establish that either app runs correctly on real devices. Windows launch, Android installation, the private connection, and device voice behavior require testing on Windows and Android hardware.
