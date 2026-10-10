const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, safeStorage } = require('electron');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createAiSetup } = require('./ai-setup.cjs');

let window;
let server;
let accessToken;
let origin;
let dataDirectory;
let ownedOllama;
let aiSetup;
let ollamaStartPromise;
let quitting = false;
let port = Number(process.env.JARVIS_DESKTOP_PORT || 3001);
const allowedLinks = new Set(['ollama.com', 'tailscale.com', 'nodejs.org']);
const ollamaUrl = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');

if (process.env.JARVIS_DESKTOP_DATA_DIR) app.setPath('userData', resolve(process.env.JARVIS_DESKTOP_DATA_DIR));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('JARVIS could not start', error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Close another JARVIS instance or another application using this port, then reopen JARVIS.`
      : error.message);
    app.quit();
  });
}

async function loadToken() {
  dataDirectory = app.getPath('userData');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const file = join(dataDirectory, 'connection.json');
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('The saved connection settings cannot be read. Back them up before repairing them.'); }
  if (config) {
    const token = config.encrypted ? safeStorage.decryptString(Buffer.from(config.token, 'base64')) : config.token;
    if (typeof token !== 'string' || token.length < 24) throw new Error('The saved phone-access key is invalid.');
    return token;
  }
  const token = randomBytes(32).toString('hex');
  // Windows encrypts this with the signed-in user's DPAPI key. On platforms
  // without an OS key store, keep the file private instead of claiming encryption.
  const encrypted = safeStorage.isEncryptionAvailable() && (process.platform === 'win32' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  await writeFile(file, JSON.stringify({ version: 1, encrypted, token: encrypted ? safeStorage.encryptString(token).toString('base64') : token }), { mode: 0o600 });
  return token;
}

function checkSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) {
    throw new Error('This operation is only available inside your JARVIS desktop app.');
  }
}

async function ollamaReachable() {
  try { return (await fetch(ollamaUrl + '/api/version', { signal: AbortSignal.timeout(3000) })).ok; }
  catch { return false; }
}

function ollamaCandidates() {
  const candidates = ['ollama'];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
      candidates.push(join(process.env.LOCALAPPDATA, 'Ollama', 'ollama.exe'));
    }
    for (const directory of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (directory) candidates.push(join(directory, 'Ollama', 'ollama.exe'));
    }
  }
  if (process.platform === 'darwin') candidates.push('/usr/local/bin/ollama');
  return [...new Set(candidates)];
}

function startOllama() {
  if (!ollamaStartPromise) ollamaStartPromise = launchOllama().finally(() => { ollamaStartPromise = undefined; });
  return ollamaStartPromise;
}

async function launchOllama() {
  if (await ollamaReachable()) return true;
  const endpoint = new URL(ollamaUrl);
  // Only launch a local server. Respect one endpoint for setup, status and chat.
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.pathname !== '/') return false;
  for (const executable of ollamaCandidates()) {
    const child = spawn(executable, ['serve'], { windowsHide: true, stdio: 'ignore',
      env: { ...process.env, OLLAMA_HOST: endpoint.host }, cwd: dataDirectory,
    });
    const started = await new Promise(resolveStarted => {
      child.once('spawn', () => resolveStarted(true));
      child.once('error', () => resolveStarted(false));
    });
    if (!started) continue;
    ownedOllama = child;
    child.once('exit', () => { if (ownedOllama === child) ownedOllama = undefined; });
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await ollamaReachable()) return true;
      if (child.exitCode !== null) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
  }
  return false;
}

async function phoneHelp() {
  if (!window) return;
  const choice = await dialog.showMessageBox(window, { type: 'info', title: 'Connect your Android phone',
    message: 'Your phone connects to the AI on this computer.',
    detail: `1. Install Tailscale on your PC and Android phone and join the same private network.\n2. Run: tailscale serve --bg http://127.0.0.1:${port}\n3. Enter the actual HTTPS address it gives you in the JARVIS Android app.\n4. Use Copy phone key below, then enter that key on the phone's unlock screen.\n\nKeep JARVIS open and this computer online. Ollama and your phone key stay private.`,
    buttons: ['Copy phone key', 'Get Tailscale', 'Close'], defaultId: 2, cancelId: 2,
  });
  if (choice.response === 0) clipboard.writeText(accessToken);
  if (choice.response === 1) await shell.openExternal('https://tailscale.com/download');
}

async function start() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid desktop server port.');
  accessToken = await loadToken();
  const { createApp } = await import(pathToFileURL(join(app.getAppPath(), 'server', 'index.mjs')).href);
  const backend = await createApp({ host: '127.0.0.1', accessToken, ollamaUrl, dataDir: join(dataDirectory, 'data'), distDir: join(app.getAppPath(), 'dist') });
  server = backend.server;
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  origin = `http://127.0.0.1:${port}`;

  aiSetup = createAiSetup({
    baseUrl: ollamaUrl, getModel: () => backend.store.get().settings.model,
    ensureService: startOllama,
    onStatus: status => { if (window && !window.isDestroyed()) window.webContents.send('jarvis:ai-setup-status', status); },
  });
  ipcMain.handle('jarvis:token', event => { checkSender(event); return accessToken; });
  ipcMain.handle('jarvis:connection', event => { checkSender(event); return { port, version: app.getVersion(), downloading: aiSetup.running, dataDirectory }; });
  ipcMain.handle('jarvis:ai-setup-status', event => { checkSender(event); return aiSetup.getStatus(); });
  ipcMain.handle('jarvis:copy-phone-key', event => { checkSender(event); clipboard.writeText(accessToken); return true; });
  ipcMain.handle('jarvis:phone-help', event => { checkSender(event); return phoneHelp(); });
  ipcMain.handle('jarvis:download-model', event => { checkSender(event); return aiSetup.start(); });
  ipcMain.handle('jarvis:install-ollama', event => { checkSender(event); return shell.openExternal('https://ollama.com/download/windows'); });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'JARVIS', submenu: [{ label: 'Connect Android phone', click: phoneHelp }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
  window = new BrowserWindow({ width: 1320, height: 940, minWidth: 850, minHeight: 650, title: 'JARVIS', backgroundColor: '#080f19',
    icon: join(app.getAppPath(), 'dist', 'icon-512.png'), show: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { const link = new URL(url); if (link.protocol === 'https:' && allowedLinks.has(link.hostname)) shell.openExternal(url); } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  const trustedPermissionOrigin = url => { try { return new URL(url).origin === origin; } catch { return false; } };
  window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return contents === window?.webContents && trustedPermissionOrigin(requestingOrigin) &&
      (permission === 'notifications' || (permission === 'media' && details.mediaType === 'audio'));
  });
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = contents === window?.webContents && trustedPermissionOrigin(details.requestingUrl) &&
      (permission === 'notifications' || (permission === 'media' && details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === 'audio')));
    callback(Boolean(allowed));
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = undefined; app.quit(); });
  await window.loadURL(origin);
  startOllama().catch(() => {});
}

app.on('before-quit', event => {
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  aiSetup?.dispose();
  if (ownedOllama) ownedOllama.kill();
  server.close(() => app.quit());
  server.closeIdleConnections();
  const forceClose = setTimeout(() => { server.closeAllConnections(); app.quit(); }, 3000);
  forceClose.unref();
});
