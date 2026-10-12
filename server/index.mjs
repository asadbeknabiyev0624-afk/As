import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createStore } from './store.mjs';
import { localCommand, systemPrompt } from './assistant.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new RequestError(400, `${label} cannot be empty.`);
  if (value.trim().length > max) throw new RequestError(400, `${label} must be ${max} characters or fewer.`);
  return value.trim();
};
const idItem = (list, id) => {
  const item = list.find(x => x.id === id);
  if (!item) throw new RequestError(404, 'That item no longer exists.');
  return item;
};

async function bodyJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new RequestError(415, 'Send application/json.');
  }
  return await new Promise((resolveBody, reject) => {
    let bytes = 0;
    let tooLarge = false;
    const chunks = [];
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          reject(new RequestError(413, 'Request is too large.'));
        }
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString());
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolveBody(value);
      } catch { reject(new RequestError(400, 'Invalid JSON request.')); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new RequestError(400, 'Request was interrupted.')));
  });
}

export async function createApp(options = {}) {
  const host = options.host ?? process.env.JARVIS_HOST ?? '127.0.0.1';
  const accessToken = options.accessToken ?? process.env.JARVIS_ACCESS_TOKEN ?? '';
  if (!loopback.has(host) && accessToken.length < 24) {
    throw new Error('Remote access requires JARVIS_ACCESS_TOKEN with at least 24 characters. Keep it outside the repository and use HTTPS.');
  }
  const ollamaUrl = options.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const parsedOllama = new URL(ollamaUrl);
  if (!['http:', 'https:'].includes(parsedOllama.protocol) || parsedOllama.username || parsedOllama.password) {
    throw new Error('OLLAMA_URL must be an HTTP(S) base URL without embedded credentials.');
  }
  const baseUrl = ollamaUrl.replace(/\/$/, '');
  const store = await createStore(options.dataDir ?? process.env.JARVIS_DATA_DIR ?? join(root, '.data'));
  const dist = options.distDir ?? join(root, 'dist');
  const fetcher = options.fetcher ?? fetch;
  const chatTimeout = options.chatTimeoutMs ?? 120000;
  let chatActive = false;
  const now = () => new Date().toISOString();

  function json(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(data));
  }

  function checkAccess(request) {
    // Restrict loopback APIs by Host as well as bind address to prevent DNS rebinding.
    const hostname = new URL(`http://${request.headers.host}`).hostname.replace(/^\[|\]$/g, '');
    if (!accessToken && !loopback.has(hostname)) throw new RequestError(403, 'Local access only. Configure secure authenticated access for other devices.');
    if (request.headers.origin) {
      let origin;
      try { origin = new URL(request.headers.origin); } catch { throw new RequestError(403, 'Invalid request origin.'); }
      if (origin.host !== request.headers.host) throw new RequestError(403, 'Cross-origin requests are not allowed.');
    }
    if (accessToken) {
      const provided = request.headers['x-jarvis-token'] ?? '';
      const a = Buffer.from(accessToken);
      const b = Buffer.from(typeof provided === 'string' ? provided : '');
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new RequestError(401, 'Enter your server access token to unlock JARVIS.');
    }
  }

  async function modelStatus() {
    const model = store.get().settings.model;
    try {
      const response = await fetcher(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
      const data = await response.json();
      if (!Array.isArray(data.models)) throw new Error('Ollama returned an unexpected model list.');
      const models = data.models.map(m => m.name).filter(m => typeof m === 'string');
      const modelAvailable = models.some(m => m === model || m === `${model}:latest`);
      return { online: true, modelAvailable, model, models, error: modelAvailable ? null : `Download ${model} with “ollama pull ${model}”, or choose an installed model in Settings.` };
    } catch {
      return { online: false, modelAvailable: false, model, models: [], error: 'Ollama is not reachable. Install Ollama, start it, and download a model. Notes and tasks work without AI.' };
    }
  }

  async function chat(request, response) {
    const { message: raw, responseLanguage = 'auto' } = await bodyJson(request);
    if (!['auto', 'en', 'uz', 'ru'].includes(responseLanguage)) throw new RequestError(400, 'Choose a supported response language.');
    const message = text(raw, 12000, 'Message');
    if (chatActive) throw new RequestError(429, 'I’m finishing another response. Please try again in a moment.');
    chatActive = true;
    try {
      const command = localCommand(message, store.get());
      if (command?.kind === 'note') text(command.content, 6000, 'Note');
      if (command?.kind === 'task') text(command.title, 300, 'Task');
      const userMessage = { id: randomUUID(), role: 'user', content: message, createdAt: now() };
      await store.mutate(s => { s.messages.push(userMessage); s.messages = s.messages.slice(-300); });
      let reply;
      if (command) {
        const state = await store.mutate(s => {
          if (command.kind === 'note') {
            s.notes.push({ id: randomUUID(), content: command.content, createdAt: now() });
            reply = `Remembered: ${command.content}\nYou can edit or delete this in Memory.`;
          } else if (command.kind === 'task') {
            s.tasks.push({ id: randomUUID(), title: command.title, dueAt: null, completed: false, createdAt: now(), notifiedAt: null });
            reply = `Added to your tasks: ${command.title}\nSet a due time on the Tasks page if you want an alert while the app is open.`;
          } else reply = command.reply;
          s.messages.push({ id: randomUUID(), role: 'assistant', content: reply, createdAt: now() });
          s.messages = s.messages.slice(-300);
        });
        return json(response, 200, { reply, source: 'local-command', state });
      }
      const state = store.get();
      try {
        const result = await fetcher(`${baseUrl}/api/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(chatTimeout),
          body: JSON.stringify({ model: state.settings.model, stream: false,
            messages: [{ role: 'system', content: systemPrompt(state, responseLanguage) }, ...state.messages.slice(-24).map(({ role, content }) => ({ role, content }))],
            options: { num_ctx: 8192, temperature: 0.7, num_predict: 1024 },
          }),
        });
        if (!result.ok) {
          let detail;
          try { detail = (await result.json()).error; } catch {}
          const diagnostic = typeof detail === 'string' ? detail.slice(0, 400) : 'Check the local model server.';
          throw new Error(result.status === 404 ? `Model ${state.settings.model} is missing. Use Download AI in JARVIS or choose an installed model in Settings.` : `Ollama returned HTTP ${result.status}: ${diagnostic}`);
        }
        const data = await result.json();
        reply = typeof data.message?.content === 'string' ? data.message.content.trim() : '';
        if (!reply) throw new Error('The model returned an empty response. Try again or choose another model.');
      } catch (error) {
        const known = error.message.startsWith('Model ') || error.message.startsWith('Ollama returned ') || error.message.startsWith('The model returned ');
        const reason = known ? error.message : error.name === 'TimeoutError' ? 'The model took too long to respond. Try a smaller model or a shorter message.' : 'I can’t reach the local AI yet. Start Ollama and download the selected model. Your message is saved; notes and tasks still work.';
        return json(response, 503, { error: reason, state: store.get() });
      }
      const updated = await store.mutate(s => { s.messages.push({ id: randomUUID(), role: 'assistant', content: reply, createdAt: now() }); s.messages = s.messages.slice(-300); });
      return json(response, 200, { reply, source: 'ollama', state: updated });
    } finally { chatActive = false; }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const method = request.method;
      if (path.startsWith('/api/')) {
        checkAccess(request);
        if (method === 'GET' && path === '/api/health') return json(response, 200, { ok: true });
        if (method === 'GET' && path === '/api/state') return json(response, 200, store.get());
        if (method === 'GET' && path === '/api/status') return json(response, 200, await modelStatus());
        if (method === 'POST' && path === '/api/chat') return await chat(request, response);
        if (method === 'DELETE' && path === '/api/messages') {
          if (chatActive) throw new RequestError(409, 'Wait for the current response before clearing the conversation.');
          return json(response, 200, { state: await store.mutate(s => { s.messages = []; }) });
        }
        if (method === 'PATCH' && path === '/api/profile') {
          const input = await bodyJson(request);
          const profile = {};
          for (const [key, max] of [['name', 100], ['aboutMe', 3000], ['preferences', 3000]]) {
            if (input[key] !== undefined) {
              if (typeof input[key] !== 'string' || input[key].length > max) throw new RequestError(400, `${key} must be a string of ${max} characters or fewer.`);
              profile[key] = input[key].trim();
            }
          }
          return json(response, 200, { state: await store.mutate(s => { Object.assign(s.profile, profile); }) });
        }
        if (method === 'PATCH' && path === '/api/settings') {
          const input = await bodyJson(request);
          const model = text(input.model, 120, 'Model');
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) throw new RequestError(400, 'Invalid model name.');
          return json(response, 200, { state: await store.mutate(s => { s.settings.model = model; }) });
        }
        if (method === 'POST' && path === '/api/notes') {
          const input = await bodyJson(request);
          const content = text(input.content, 6000, 'Note');
          return json(response, 201, { state: await store.mutate(s => { s.notes.push({ id: randomUUID(), content, createdAt: now() }); }) });
        }
        if (method === 'POST' && path === '/api/tasks') {
          const input = await bodyJson(request);
          const title = text(input.title, 300, 'Task');
          const dueAt = input.dueAt ? new Date(input.dueAt) : null;
          if (dueAt && Number.isNaN(dueAt.getTime())) throw new RequestError(400, 'Choose a valid due date.');
          return json(response, 201, { state: await store.mutate(s => { s.tasks.push({ id: randomUUID(), title, dueAt: dueAt?.toISOString() ?? null, completed: false, createdAt: now(), notifiedAt: null }); }) });
        }
        const itemRoute = path.match(/^\/api\/(notes|tasks)\/([a-zA-Z0-9-]+)$/);
        if (itemRoute && method === 'DELETE') {
          const [, list, id] = itemRoute;
          return json(response, 200, { state: await store.mutate(s => { idItem(s[list], id); s[list] = s[list].filter(x => x.id !== id); }) });
        }
        if (itemRoute && method === 'PATCH') {
          const [, list, id] = itemRoute;
          const input = await bodyJson(request);
          const changes = {};
          if (list === 'notes') changes.content = text(input.content, 6000, 'Note');
          else {
            if ('completed' in input) {
              if (typeof input.completed !== 'boolean') throw new RequestError(400, 'completed must be true or false.');
              changes.completed = input.completed;
            }
            if ('title' in input) changes.title = text(input.title, 300, 'Task');
            for (const key of ['dueAt', 'notifiedAt']) {
              if (key in input) {
                const date = input[key] === null ? null : new Date(input[key]);
                if (date && Number.isNaN(date.getTime())) throw new RequestError(400, `Invalid ${key}.`);
                changes[key] = date?.toISOString() ?? null;
              }
            }
            if ('dueAt' in changes || changes.completed === false) changes.notifiedAt = null;
          }
          return json(response, 200, { state: await store.mutate(s => { Object.assign(idItem(s[list], id), changes); }) });
        }
        throw new RequestError(404, 'API route not found.');
      }
      if (!['GET', 'HEAD'].includes(method)) throw new RequestError(405, 'Method not allowed.');
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { throw new RequestError(400, 'Invalid path.'); }
      const file = resolve(dist, `.${decoded}`);
      if (file !== dist && !file.startsWith(`${dist}${sep}`)) throw new RequestError(403, 'Invalid path.');
      let target = file;
      try { if (!(await stat(target)).isFile()) target = join(dist, 'index.html'); }
      catch { target = extname(decoded) ? null : join(dist, 'index.html'); }
      if (!target) throw new RequestError(404, 'File not found.');
      let data;
      try { data = await readFile(target); } catch { throw new RequestError(404, 'Build the app with npm run build, or run npm run dev.'); }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
      response.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream', 'Cache-Control': extname(target) === '.html' || target.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600' });
      response.end(method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!error.status) console.error('Request failed:', error.message);
      if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : 'The request could not be saved. Check server logs and try again.' });
      else response.end();
    }
  });
  server.requestTimeout = 150000;
  return { server, store, host };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = await createApp();
    const port = Number(process.env.JARVIS_PORT ?? 3001);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('JARVIS_PORT must be a valid port.');
    app.server.on('error', error => { console.error(`JARVIS could not start: ${error.message}`); process.exitCode = 1; });
    app.server.listen(port, app.host, () => console.log(`JARVIS is listening on ${app.host}:${port}. Personal data stays in the configured data directory.`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app.server.close(); app.server.closeIdleConnections(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
