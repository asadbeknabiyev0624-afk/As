import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

// These tests use an HTTP mock of Ollama. They verify application behavior,
// not the quality or availability of a downloaded language model.
const model = 'qwen2.5:1.5b';

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

function requestWithHost(url, host) {
  // Fetch controls Host itself; use node:http to exercise the rebinding guard.
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: host } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        data: JSON.parse(Buffer.concat(chunks).toString()),
      }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function fixture(t, { provider, appOptions = {} } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-integration-'));
  const calls = [];
  let app;
  let url;
  const ollama = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const call = {
        method: request.method,
        path: request.url,
        body: raw ? JSON.parse(raw) : undefined,
      };
      calls.push(call);
      if (provider) return await provider(call, response);
      if (call.path === '/api/tags') {
        return sendJson(response, 200, { models: [{ name: model }, { name: 'another:latest' }] });
      }
      if (call.path === '/api/chat') {
        return sendJson(response, 200, { message: { role: 'assistant', content: 'A response from the mock model.' } });
      }
      return sendJson(response, 404, { error: 'Unknown mock route.' });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });

  t.after(async () => {
    await close(app?.server);
    await close(ollama);
    await rm(dataDir, { recursive: true, force: true });
  });

  const ollamaUrl = await listen(ollama);
  const options = { dataDir, ollamaUrl, host: '127.0.0.1', accessToken: '', ...appOptions };
  async function start() {
    app = await createApp(options);
    url = await listen(app.server);
  }
  await start();

  return {
    calls,
    get url() { return url; },
    async request(path, { method = 'GET', body, rawBody, headers = {} } = {}) {
      const hasBody = body !== undefined || rawBody !== undefined;
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(hasBody ? { body: rawBody ?? JSON.stringify(body) } : {}),
      });
      const raw = await response.text();
      return { status: response.status, data: raw ? JSON.parse(raw) : null, headers: response.headers };
    },
    async restart() {
      await close(app.server);
      await start();
    },
    async stopProvider() {
      await close(ollama);
    },
  };
}

test('profile, notes, tasks and settings survive a real server restart and support CRUD', async t => {
  const app = await fixture(t);
  const initial = await app.request('/api/state');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data.notes, []);
  assert.deepEqual(initial.data.tasks, []);

  const profile = await app.request('/api/profile', {
    method: 'PATCH', body: { name: '  Ada  ', aboutMe: 'I am learning physics.', preferences: 'Explain with examples.' },
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.state.profile.name, 'Ada');
  assert.equal((await app.request('/api/settings', { method: 'PATCH', body: { model: 'another:latest' } })).status, 200);

  const note = await app.request('/api/notes', { method: 'POST', body: { content: '  Reading matters to me.  ' } });
  assert.equal(note.status, 201);
  const noteId = note.data.state.notes[0].id;
  const editedNote = await app.request(`/api/notes/${noteId}`, { method: 'PATCH', body: { content: 'Read a little every day.' } });
  assert.equal(editedNote.status, 200);

  const task = await app.request('/api/tasks', {
    method: 'POST', body: { title: '  Read a chapter  ', dueAt: '2027-01-02T10:30:00Z' },
  });
  assert.equal(task.status, 201);
  const taskId = task.data.state.tasks[0].id;
  assert.equal(task.data.state.tasks[0].title, 'Read a chapter');
  assert.equal(task.data.state.tasks[0].dueAt, '2027-01-02T10:30:00.000Z');
  const editedTask = await app.request(`/api/tasks/${taskId}`, {
    method: 'PATCH', body: { title: 'Read two chapters', completed: true },
  });
  assert.equal(editedTask.status, 200);
  assert.equal(editedTask.data.state.tasks[0].completed, true);

  const beforeRestart = (await app.request('/api/state')).data;
  await app.restart();
  assert.deepEqual((await app.request('/api/state')).data, beforeRestart);

  assert.equal((await app.request(`/api/notes/${noteId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await app.request(`/api/tasks/${taskId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await app.request('/api/profile', { method: 'PATCH', body: { name: '', aboutMe: '', preferences: '' } })).status, 200);
  const final = (await app.request('/api/state')).data;
  assert.deepEqual(final.notes, []);
  assert.deepEqual(final.tasks, []);
  assert.deepEqual(final.profile, { name: '', aboutMe: '', preferences: '' });
  assert.equal(final.settings.model, 'another:latest');
});

test('malformed and invalid mutations reject the request without losing existing data', async t => {
  const app = await fixture(t);
  const saved = await app.request('/api/notes', { method: 'POST', body: { content: 'Keep this note.' } });
  const noteId = saved.data.state.notes[0].id;
  const task = await app.request('/api/tasks', { method: 'POST', body: { title: 'Keep this task.' } });
  const taskId = task.data.state.tasks[0].id;
  const before = (await app.request('/api/state')).data;
  const cases = [
    ['/api/notes', { method: 'POST', rawBody: '{not valid json' }, 400],
    ['/api/notes', { method: 'POST', body: [] }, 400],
    ['/api/notes', { method: 'POST', body: { content: 'x'.repeat(66 * 1024) } }, 413],
    ['/api/notes', { method: 'POST', body: { content: '   ' } }, 400],
    [`/api/notes/${noteId}`, { method: 'PATCH', body: { content: 17 } }, 400],
    ['/api/profile', { method: 'PATCH', body: { name: 'Should not save', preferences: false } }, 400],
    ['/api/tasks', { method: 'POST', body: { title: 'Bad date', dueAt: 'not-a-date' } }, 400],
    [`/api/tasks/${taskId}`, { method: 'PATCH', body: { completed: 'true' } }, 400],
    ['/api/settings', { method: 'PATCH', body: { model: 'invalid model with spaces' } }, 400],
    ['/api/notes/missing-id', { method: 'DELETE' }, 404],
    ['/api/notes', { method: 'POST', body: { content: 'Wrong media type' }, headers: { 'Content-Type': 'text/plain' } }, 415],
  ];
  for (const [path, options, expectedStatus] of cases) {
    const result = await app.request(path, options);
    assert.equal(result.status, expectedStatus, `${options.method} ${path}`);
    assert.equal(typeof result.data.error, 'string');
    assert.deepEqual((await app.request('/api/state')).data, before);
  }
  await app.restart();
  assert.deepEqual((await app.request('/api/state')).data, before);
  // An unsuccessful mutation must not poison the persistence queue.
  assert.equal((await app.request('/api/notes', { method: 'POST', body: { content: 'A later valid note.' } })).status, 201);
});

test('API access requires the configured token and rejects foreign origins', async t => {
  const token = 'integration-test-token-0123456789';
  const app = await fixture(t, { appOptions: { accessToken: token } });
  assert.equal((await app.request('/api/state')).status, 401);
  assert.equal((await app.request('/api/state', { headers: { 'X-Jarvis-Token': 'wrong-token' } })).status, 401);
  assert.equal((await app.request('/api/notes', { method: 'POST', body: { content: 'Unauthorized' } })).status, 401);

  const headers = { 'X-Jarvis-Token': token };
  const permitted = await app.request('/api/state', { headers: { ...headers, Origin: app.url } });
  assert.equal(permitted.status, 200);
  assert.deepEqual(permitted.data.notes, []);
  assert.equal(permitted.headers.get('cache-control'), 'no-store');
  assert.equal((await app.request('/api/state', { headers: { ...headers, Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await app.request('/api/state', { headers: { ...headers, Origin: 'null' } })).status, 403);
});

test('local-only API rejects a foreign Host and remote binding requires a strong access token', async t => {
  const app = await fixture(t);
  assert.equal((await requestWithHost(`${app.url}/api/state`, 'foreign.example')).status, 403);
  assert.equal((await app.request('/api/state', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  for (const accessToken of ['', 'too-short']) {
    await assert.rejects(createApp({ host: '0.0.0.0', accessToken }), /at least 24 characters/);
  }
});

test('mock Ollama conversation uses personal context and history and persists the provider reply', async t => {
  const app = await fixture(t);
  const status = await app.request('/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.online, true);
  assert.equal(status.data.modelAvailable, true);
  assert.deepEqual(status.data.models, [model, 'another:latest']);
  await app.request('/api/profile', { method: 'PATCH', body: { name: 'Ada', preferences: 'Use short examples.' } });
  await app.request('/api/chat', { method: 'POST', body: { message: 'remember My favorite subject is physics.' } });
  await app.request('/api/tasks', { method: 'POST', body: { title: 'Practice mechanics.' } });
  const done = await app.request('/api/tasks', { method: 'POST', body: { title: 'An already completed task.' } });
  const doneId = done.data.state.tasks.find(task => task.title === 'An already completed task.').id;
  await app.request(`/api/tasks/${doneId}`, { method: 'PATCH', body: { completed: true } });

  const reply = await app.request('/api/chat', { method: 'POST', body: { message: 'Help me plan a study session.' } });
  assert.equal(reply.status, 200);
  assert.equal(reply.data.source, 'ollama');
  assert.equal(reply.data.reply, 'A response from the mock model.');
  const providerCall = app.calls.find(call => call.path === '/api/chat');
  assert.equal(providerCall.method, 'POST');
  assert.equal(providerCall.body.model, model);
  assert.equal(providerCall.body.stream, false);
  const messages = providerCall.body.messages;
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /Never invent personal facts/);
  const context = JSON.parse(messages[0].content.split('PERSONAL CONTEXT (JSON):\n')[1]);
  assert.equal(context.profile.name, 'Ada');
  assert.equal(context.profile.preferences, 'Use short examples.');
  assert.equal(context.notes[0].content, 'My favorite subject is physics.');
  assert.deepEqual(context.tasks.map(task => task.title), ['Practice mechanics.']);
  assert.ok(messages.some(message => message.role === 'user' && message.content.startsWith('remember ')));
  assert.deepEqual(messages.at(-1), { role: 'user', content: 'Help me plan a study session.' });
  assert.equal(reply.data.state.messages.at(-1).role, 'assistant');
  assert.equal(reply.data.state.messages.at(-1).content, reply.data.reply);

  await app.restart();
  assert.deepEqual((await app.request('/api/state')).data, reply.data.state);
  const cleared = await app.request('/api/messages', { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.data.state.messages, []);
  assert.equal(cleared.data.state.notes.length, 1);
  assert.equal(cleared.data.state.tasks.length, 2);
});

test('missing models and unavailable Ollama save the user message without inventing an assistant response', async t => {
  const app = await fixture(t, {
    provider(call, response) {
      if (call.path === '/api/tags') return sendJson(response, 200, { models: [{ name: 'some-other-model:latest' }] });
      return sendJson(response, 404, { error: 'Model missing in the mock provider.' });
    },
  });
  const status = await app.request('/api/status');
  assert.equal(status.data.online, true);
  assert.equal(status.data.modelAvailable, false);
  assert.match(status.data.error, /ollama pull/);
  const missing = await app.request('/api/chat', { method: 'POST', body: { message: 'A question for the missing model.' } });
  assert.equal(missing.status, 503);
  assert.match(missing.data.error, /Model .* is missing/);
  assert.deepEqual(missing.data.state.messages.map(message => message.role), ['user']);

  await app.stopProvider();
  const disconnected = await app.request('/api/status');
  assert.equal(disconnected.data.online, false);
  const unavailable = await app.request('/api/chat', { method: 'POST', body: { message: 'A question while Ollama is stopped.' } });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.data.state.messages.map(message => message.role), ['user', 'user']);
  assert.equal(unavailable.data.state.messages.at(-1).content, 'A question while Ollama is stopped.');
  assert.deepEqual((await app.request('/api/state')).data, unavailable.data.state);
});

test('British English speech preference reaches the model and rejects unsupported languages', async t => {
  const app = await fixture(t);
  const response = await app.request('/api/chat', { method: 'POST', body: { message: 'Salom, yordam bering.', responseLanguage: 'en' } });
  assert.equal(response.status, 200);
  const prompt = app.calls.find(call => call.path === '/api/chat').body.messages[0].content;
  assert.match(prompt, /natural British English/);
  const state = (await app.request('/api/state')).data;
  const invalid = await app.request('/api/chat', { method: 'POST', body: { message: 'Another question.', responseLanguage: 'untrusted' } });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await app.request('/api/state')).data, state);
});

test('an Ollama resource failure is shown clearly without inventing an assistant reply', async t => {
  const app = await fixture(t, { provider(call, response) {
    return sendJson(response, 500, { error: 'model requires more system memory than is available' });
  } });
  const response = await app.request('/api/chat', { method: 'POST', body: { message: 'Please help.' } });
  assert.equal(response.status, 503);
  assert.match(response.data.error, /more system memory/);
  assert.deepEqual(response.data.state.messages.map(message => message.role), ['user']);
});

test('explicit local commands save and list useful data without contacting a model', async t => {
  const app = await fixture(t);
  await app.stopProvider();
  const chat = message => app.request('/api/chat', { method: 'POST', body: { message } });
  const remembered = await chat('remember My dog is named Pip.');
  assert.equal(remembered.status, 200);
  assert.equal(remembered.data.source, 'local-command');
  assert.equal(remembered.data.state.notes[0].content, 'My dog is named Pip.');
  const task = await chat('add task Walk Pip.');
  assert.equal(task.status, 200);
  assert.equal(task.data.state.tasks[0].title, 'Walk Pip.');
  for (const [command, expectedText] of [
    ['show my notes', 'My dog is named Pip.'],
    ['show my tasks', 'Walk Pip.'],
    ['help', 'remember [fact]'],
  ]) {
    const result = await chat(command);
    assert.equal(result.status, 200);
    assert.equal(result.data.source, 'local-command');
    assert.ok(result.data.reply.includes(expectedText));
  }
  assert.equal(app.calls.length, 0);
  await app.restart();
  const saved = (await app.request('/api/state')).data;
  assert.equal(saved.notes.length, 1);
  assert.equal(saved.tasks.length, 1);
  assert.deepEqual(saved.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
});

test('an in-flight model reply prevents conflicting chat and conversation deletion', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, {
    async provider(call, response) {
      entered();
      await gate;
      sendJson(response, 200, { message: { content: 'The first request completed.' } });
    },
  });
  const firstRequest = app.request('/api/chat', { method: 'POST', body: { message: 'First request.' } });
  let second;
  let clear;
  try {
    await started;
    second = await app.request('/api/chat', { method: 'POST', body: { message: 'Second request.' } });
    clear = await app.request('/api/messages', { method: 'DELETE' });
  } finally {
    release();
  }
  const first = await firstRequest;
  assert.equal(second.status, 429);
  assert.equal(clear.status, 409);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.state.messages.map(message => message.content), ['First request.', 'The first request completed.']);
  assert.equal((await app.request('/api/messages', { method: 'DELETE' })).status, 200);
});
