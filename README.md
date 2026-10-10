# JARVIS

A personal assistant inspired by Tony Stark's companion: a place to talk things through, get practical advice, remember useful facts, and organize tasks. Run the Windows EXE on your computer and connect the Android APK to it. AI conversation uses a free local Ollama model on your PC.

## Use the Windows EXE and Android APK

- [Download Windows EXE v0.1.1](https://github.com/asadbeknabiyev0624-afk/As/raw/refs/heads/jarvis-downloads/JARVIS-Windows-v0.1.1.exe) · [Download Android APK](https://github.com/asadbeknabiyev0624-afk/As/raw/refs/heads/jarvis-downloads/JARVIS-Android.apk)
- [Browse downloads and checksums](https://github.com/asadbeknabiyev0624-afk/As/tree/jarvis-downloads)

- **Windows 10/11, x64:** Open the updated `JARVIS-Windows.exe` (version **0.1.1**). No Node.js or npm installation is needed to run it.
- **Android 8+:** Install `JARVIS-Android.apk`. The phone connects to the Windows app; it does not contain an AI model.

If Ollama is already installed, open JARVIS and choose **Download AI** on Overview or Conversation. Otherwise, choose **Install Ollama** in the setup card, finish installation, and reopen JARVIS first. The default `qwen2.5:1.5b` model is about 1 GB. Keep JARVIS open and wait until it says **Connected and ready**. Download progress and any error stay visible in the setup card; the same controls are available in Settings. JARVIS checks that the model is installed before reporting readiness. Notes and tasks work before AI setup finishes.

For the phone, install Tailscale on both devices, enable private HTTPS with Tailscale Serve, and enter that HTTPS address in the Android app. Use **Copy phone key** in the Windows app and enter the key on the phone's unlock screen. Keep your PC awake, online, and running JARVIS while using the phone.

Follow the [EXE + APK setup guide](docs/NATIVE.md) for the exact installation and connection steps, troubleshooting, and native build instructions. The Windows build is unsigned; the APK uses a personal development signing key. Hardware launch and voice behavior require testing on your devices.

The app includes chat, saved memories and tasks, a personal profile, model selection, push-to-talk, and spoken replies. The source also supports a browser app with installation from a supported browser.

## Develop or run the web app from source

- Node.js 24 is recommended for development and native builds; the application server requires Node.js 22 or newer.
- [Ollama](https://ollama.com/) for AI conversation, with enough available memory for your chosen model.
- A modern browser. Voice features depend on browser and device support.

The application and local commands can run before Ollama is installed. AI conversation becomes available when the app can reach a running Ollama instance with an installed model.

## Set up local AI

Install Ollama using the instructions for your operating system at [ollama.com](https://ollama.com/). Start Ollama, then download the default small model:

```sh
ollama pull qwen2.5:1.5b
```

If your installation does not start Ollama automatically, run `ollama serve` in another terminal. Its default address is `http://127.0.0.1:11434`.

The app lists installed Ollama models so you can choose another one. A larger model may give better answers but needs more memory and processing time. Local inference has no per-message API charge; the computer, electricity, and any hosting still have costs.

## Run in development

From this repository:

```sh
npm ci
npm run dev
```

Use `npm install` instead of `npm ci` when intentionally creating or updating the dependency lockfile. For a normal checkout with its lockfile, use `npm ci`.

Development starts the Node application server on port **3001** and Vite on port **5173**. Open `http://localhost:5173` on your computer. Keep Ollama running in the background for AI replies.

## Run the production build

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3001` on your computer. The Node server serves both the built interface and the application API.

## Configuration

Set environment variables in the shell or service that starts the app. Keep credentials outside the repository.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Address of the Ollama server used for AI replies. |
| `JARVIS_PORT` | `3001` | Node application server port. |
| `JARVIS_HOST` | `127.0.0.1` | Address the Node server listens on. |
| `JARVIS_DATA_DIR` | `.data` | Directory for persistent personal data. |
| `JARVIS_ACCESS_TOKEN` | Unset | Access token required when listening on a non-loopback address. |

For example, you can choose a different local port without changing project files:

```sh
JARVIS_PORT=3002 npm start
```

When an access token is configured, enter it in the app's unlock screen. You can change the browser's token in Settings. The browser remembers it in local storage; API requests send it through the `X-Jarvis-Token` header. Supply the server's token securely through its environment, never through a committed file.

## Personal data and local commands

Notes, tasks, profile details, and chat history are saved on the server in `.data/state.json` by default. Devices connecting to the same server share this data. The browser also caches loaded data for read-only offline viewing. Protect the server and your browser profile, and back up important data. These files and the browser cache are not encrypted by this app.

Use the interface to manage notes, tasks, and your profile. These chat commands also work without Ollama while the application server is reachable:

```text
remember My gym days are Monday and Wednesday
add task Read ten pages tonight
show my tasks
show my notes
help
```

Other chat messages go to the selected Ollama model when it is available. Connection status and error messages make it clear when the model is unavailable. Saved memories provide context for conversation; the assistant has no independent access to your email, calendar, files, or other accounts.

## Keep it with you on your phone

For the EXE and APK, follow the [native setup guide](docs/NATIVE.md). For the source/browser workflow, use the [Windows setup guide](docs/WINDOWS.md) or the [general computer and Android guide](docs/ANDROID.md).

The app can be installed from a supported browser's **Install app** or **Add to Home Screen** option. For useful phone access, the phone must connect to the same running application server.

Use the production build behind an authenticated HTTPS reverse proxy or a secure private-network connection. If the Node server listens beyond loopback, configure `JARVIS_ACCESS_TOKEN` with at least 24 characters before starting it. Forward app requests through that server so its access checks continue to apply, and keep Ollama private. HTTPS is also needed for normal remote microphone and installable-web-app support.

Installing the app does not move the AI model onto your phone or make the server stay online. The cached app shell can load offline, but AI replies and server-backed data operations require a connection. No external deployment or publication is performed by the repository's setup commands.

## Voice and reminders

Use push-to-talk where your browser supports speech recognition, or type normally. Browser speech recognition may use the browser vendor's servers and does not provide guaranteed offline transcription. Spoken replies use voices available on your device, so the voice and support vary.

This version does not continuously listen in the background. Your task list is available inside the app; it does not guarantee reminders after the app is closed. It is a helpful companion for advice and organization, with the capabilities shown in its interface.

## Validate the installation

Run the automated checks and build:

```sh
npm test
npm run build
```

These checks are separate from verifying a real local AI model. With Ollama running and the default model downloaded, check it directly:

```sh
curl http://127.0.0.1:11434/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5:1.5b","messages":[{"role":"user","content":"What is 12 plus 9? Answer briefly."}],"stream":false}'
```

Then open JARVIS, select the installed model, and send an ordinary question. Confirm that a model response appears. Add a note and a task, restart the application server, and confirm they remain available. Test voice only on devices that report support.

## Troubleshooting

- **AI is unavailable:** Confirm Ollama is running, check `OLLAMA_URL`, and run `ollama list` to see installed models. Pull the selected model if it is missing.
- **A model is slow or fails to load:** Close other memory-heavy applications or select a smaller model. Keep the application usable through its local commands while resolving the model issue.
- **The app asks for a token:** Enter the token configured on the application server. A token for one server will not unlock a different server.
- **The phone cannot connect:** Confirm the server is running, its listening address allows the intended connection, and your HTTPS or private-network route reaches the production server.
- **Voice controls are unavailable:** Use text input or another supported browser. For remote access, confirm you are using HTTPS.
- **Data appears missing on another device:** Check that both devices reach the same server and that the server uses the same `JARVIS_DATA_DIR` after restart.
