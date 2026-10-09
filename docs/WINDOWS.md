# JARVIS on Windows and Android

## Run it on your Windows computer

1. Install [Node.js LTS](https://nodejs.org/) (version 22 or newer).
2. Install [Ollama for Windows](https://ollama.com/download/windows), then open Ollama.
3. Extract the JARVIS project ZIP to a folder you control, such as `Documents\JARVIS`. Open that folder in File Explorer, then open a PowerShell terminal there. The folder should contain `package.json`.
4. Run these commands one at a time:

   ```powershell
   ollama pull qwen2.5:1.5b
   npm.cmd ci
   npm.cmd run build
   npm.cmd start
   ```

5. On that computer, open `http://127.0.0.1:3001` in Chrome or Edge. You should see **JARVIS connected**. Add your name and preferences in Settings, then try a conversation.

Keep Ollama running and the terminal open. After the first setup, you only need to start Ollama and run `npm.cmd start` from the project folder. The model download and dependency installation do not need to repeat unless you change them.

## Connect your Android phone

The phone uses the AI on your PC. Your PC must stay online and awake, including when you are away from home.

1. Install [Tailscale](https://tailscale.com/download) on Windows and Android. Join both devices to the same private network. Check the current personal-plan options when creating your account.
2. Create a random password of at least 24 characters in your password manager. This is your own JARVIS access token. Keep it private and available on both devices.
3. Stop JARVIS with **Ctrl+C** in its PowerShell window. Start it again using the commands below. The password prompt is masked; paste your token there, never into this chat or the repository.

   ```powershell
   $jarvisSecret = Read-Host "JARVIS access token" -AsSecureString
   $env:JARVIS_ACCESS_TOKEN = [System.Net.NetworkCredential]::new("", $jarvisSecret).Password
   npm.cmd start
   ```

   Repeat these startup commands in a new terminal session when you want protected phone access. Your browser may now ask for the same token on the computer too.
4. Open another PowerShell window on the PC and run:

   ```powershell
   tailscale serve --bg http://127.0.0.1:3001
   ```

   Follow any prompt to enable private HTTPS. Copy the actual HTTPS address Tailscale gives you.
5. Keep Tailscale connected on Android. Open that HTTPS address in Chrome and enter your JARVIS token.
6. In Chrome's menu, select **Install app** or **Add to Home screen**. JARVIS now has an icon on your phone.

Use **Tailscale Serve**, which keeps access inside your private network. Keep Ollama private, and leave JARVIS's listening address at its local default. This guide prepares a private connection; the app has not been deployed onto your devices automatically.

## Make it yours

In Settings, tell JARVIS your name, goals, and how you like advice. For example: “Be concise, honest, and practical. Help me think before making big decisions.” Use Memory for details you want included in future conversations.

Tap the microphone to dictate, then send the message. Turn on spoken replies with the speaker button. Voice support depends on the browser and may use its online speech service. The app uses push-to-talk; it does not continuously listen in the background.

Notes and tasks are stored on your PC and shared across connected devices. Offline, the phone can show cached information; AI and changes need the running PC. Due-task notifications run while the app is open and connected.

## If something does not connect

- **`node`, `npm.cmd`, or `ollama` is not recognized:** Close and reopen PowerShell after installing the apps. Confirm the installation finished.
- **AI needs setup:** Make sure Ollama is running and the selected model appears in `ollama list`.
- **The phone cannot open JARVIS:** Confirm Tailscale is connected on both devices, the PC is awake, and the JARVIS terminal is still running.
- **Unlock fails:** Use the exact token you entered when starting this server. Keep that token in your password manager.
- **Voice does not work:** Allow microphone access to the HTTPS site in Chrome, or use text.
