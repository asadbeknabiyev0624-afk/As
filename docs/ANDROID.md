# Your computer + Android phone

Your computer runs the AI. Your phone opens the same JARVIS app, so both devices share your conversations, memories, and tasks. Keep the computer online and awake when you want AI replies on your phone.

## First, run JARVIS on your computer

1. Install Node.js 22+ and Ollama using their official installers for your operating system.
2. Download this project folder to your computer.
3. In a terminal inside the project folder, run:

   ```sh
   ollama pull qwen2.5:1.5b
   npm ci
   npm run build
   npm start
   ```

4. Open `http://127.0.0.1:3001` on that computer. Check that the connection indicator says **JARVIS connected**. In Settings, add your name and how you like to be helped.

Ollama must also stay running. Its desktop app normally handles this; otherwise run `ollama serve` in another terminal. Your own model has no paid AI API subscription. A larger model is optional if your computer has enough memory.

## Connect your phone privately

For access on Wi-Fi and when you are away, use a private connection between your computer and phone. One option is Tailscale with its HTTPS Serve feature. Check its current personal-plan availability when signing up. You can also use your own authenticated HTTPS reverse proxy.

For Tailscale:

1. Install Tailscale on your computer and Android phone and sign in to the same private network. This is setup on **your devices**, not a VPN installation in the Codex cloud container.
2. Create a random private access token of at least 24 characters in your password manager. Set it as `JARVIS_ACCESS_TOKEN` on the computer before starting JARVIS. Keep the same token available on your phone. Do not send it in chat or put it into Git.
3. Restart `npm start` with that environment variable configured. Keep `JARVIS_HOST` at its local default; Tailscale can reach the local app without exposing Ollama.
4. On the computer, run:

   ```sh
   tailscale serve --bg http://127.0.0.1:3001
   ```

   Follow any prompt to enable HTTPS for your private network. Use the **actual HTTPS address** that Tailscale prints.
5. With Tailscale connected on Android, open that address in Chrome. Enter your JARVIS access token on the unlock screen.
6. In Chrome's menu, choose **Install app** or **Add to Home screen**. Open JARVIS from its new icon.

Keep this route private; Tailscale Serve and a public share/tunnel are different features. Use Serve for this setup. This project does not publish your personal assistant or configure a connection on your devices automatically.

## Talk to JARVIS

Tap the microphone to dictate, review the text, then send it. Enable spoken replies with the speaker button or in Settings. Chrome may ask for microphone permission. Browser dictation support and voices vary, and recognition may use the browser vendor's speech service.

Try:

```text
Help me think through a decision. Ask me what I’m deciding first.
remember I prefer short, honest advice with examples
add task Read ten pages tonight
show my tasks
```

Use the Tasks page to set a due time. Reminder notifications run while JARVIS is open and connected. Offline, you can read cached information; new messages and changes need the server. This version uses push-to-talk and does not listen continuously in the background.
