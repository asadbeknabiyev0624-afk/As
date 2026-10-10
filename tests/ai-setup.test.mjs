import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import aiSetup from '../desktop/ai-setup.cjs';

const { createAiSetup, DEFAULT_MODEL } = aiSetup;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { basePath = '', pull, versionStatus = 200 } = {}) {
  const provider = { models: [], calls: [] };
  const setups = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const call = { path: request.url, method: request.method, body: raw ? JSON.parse(raw) : undefined };
      provider.calls.push(call);
      if (request.url === basePath + '/api/version') return json(response, versionStatus, { version: 'test' });
      if (request.url === basePath + '/api/tags') return json(response, 200, { models: provider.models });
      if (request.url === basePath + '/api/pull' && pull) return await pull(response, call, provider);
      json(response, 404, { error: 'Unexpected provider request.' });
    } catch (error) {
      if (!response.headersSent) json(response, 500, { error: error.message });
      else response.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(async () => {
    for (const setup of setups) setup.dispose();
    await Promise.all(setups.map(setup => setup.waitUntilSettled()));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  return {
    ...provider,
    provider,
    setup(options = {}) {
      const statuses = [];
      const setup = createAiSetup({
        baseUrl: `http://127.0.0.1:${server.address().port}${basePath}`,
        onStatus: status => statuses.push(status),
        ...options,
      });
      setups.push(setup);
      return { setup, statuses };
    },
  };
}

test('downloads through a reachable Ollama HTTP server, reports streamed progress, and verifies installation', async t => {
  const provider = await fixture(t, {
    async pull(response, call, state) {
      assert.deepEqual(call.body, { model: DEFAULT_MODEL, stream: true });
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      // Real fetch receives an incomplete JSON record, not just complete mock objects.
      response.write('{"status":"pulling manifest"}\n{"status":"pulling layer","total":100,');
      await new Promise(resolve => setTimeout(resolve, 10));
      response.write('"completed":35}\n');
      await new Promise(resolve => setTimeout(resolve, 10));
      state.models = [{ name: DEFAULT_MODEL }];
      response.end('{"status":"verifying sha256 digest"}\n{"status":"success"}');
    },
  });
  const { setup, statuses } = provider.setup();
  assert.equal(setup.start().running, true);
  await setup.waitUntilSettled();
  assert.equal(setup.running, false);
  assert.equal(setup.getStatus().phase, 'ready');
  assert.equal(setup.getStatus().progress, 100);
  assert.ok(statuses.some(status => status.phase === 'downloading' && status.progress === 35));
  assert.deepEqual(provider.calls.map(call => call.path), ['/api/version', '/api/tags', '/api/pull', '/api/tags']);
  assert.equal(statuses.filter(status => status.phase === 'ready').length, 1);
});

test('an installed model is ready through HTTP without needing a CLI executable or a second download', async t => {
  const provider = await fixture(t);
  provider.provider.models = [{ name: DEFAULT_MODEL }];
  const { setup, statuses } = provider.setup();
  setup.start();
  await setup.waitUntilSettled();
  assert.equal(setup.getStatus().phase, 'ready');
  assert.deepEqual(provider.calls.map(call => call.path), ['/api/version', '/api/tags']);
  assert.ok(!statuses.some(status => status.phase === 'downloading'));
});

test('a completed pull does not claim success while the requested model is still missing', async t => {
  const provider = await fixture(t, {
    pull(response, call, state) {
      state.models = [{ name: 'a-different-model:latest' }];
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end('{"status":"success"}\n');
    },
  });
  const { setup, statuses } = provider.setup();
  setup.start();
  await setup.waitUntilSettled();
  assert.equal(setup.getStatus().phase, 'error');
  assert.match(setup.getStatus().error, /qwen2\.5:1\.5b.*still missing/i);
  assert.ok(!statuses.some(status => status.phase === 'ready'));
});

test('HTTP failures and streamed disk errors are visible and retry can recover', async t => {
  let attempt = 0;
  const provider = await fixture(t, {
    pull(response, call, state) {
      attempt++;
      if (attempt === 1) return json(response, 503, { error: 'Registry temporarily unavailable.' });
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      if (attempt === 2) return response.end('{"status":"pulling layer"}\n{"error":"no space left on device"}\n');
      state.models = [{ name: DEFAULT_MODEL }];
      response.end('{"status":"success"}\n');
    },
  });
  const { setup, statuses } = provider.setup();
  setup.start();
  await setup.waitUntilSettled();
  assert.equal(setup.running, false);
  assert.equal(setup.getStatus().phase, 'error');
  assert.equal(setup.getStatus().error, 'Registry temporarily unavailable.');
  assert.ok(!statuses.some(status => status.phase === 'ready'));

  setup.start();
  await setup.waitUntilSettled();
  assert.equal(setup.running, false);
  assert.equal(setup.getStatus().phase, 'error');
  assert.equal(setup.getStatus().error, 'no space left on device');
  assert.ok(!statuses.some(status => status.phase === 'ready'));

  setup.start();
  await setup.waitUntilSettled();
  assert.equal(attempt, 3);
  assert.equal(setup.getStatus().phase, 'ready');
  assert.equal(setup.getStatus().error, null);
});

test('concurrent setup clicks share one in-flight pull instead of launching duplicate downloads', async t => {
  const entered = deferred();
  const release = deferred();
  const provider = await fixture(t, {
    async pull(response, call, state) {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write('{"status":"pulling layer","total":100,"completed":10}\n');
      entered.resolve();
      await release.promise;
      state.models = [{ name: DEFAULT_MODEL }];
      response.end('{"status":"success"}\n');
    },
  });
  t.after(() => release.resolve());
  const { setup } = provider.setup();
  assert.equal(setup.start().running, true);
  assert.equal(setup.start().running, true);
  const completion = setup.waitUntilSettled();
  await entered.promise;
  assert.equal(setup.running, true);
  assert.equal(setup.start().running, true);
  assert.strictEqual(setup.waitUntilSettled(), completion);
  assert.equal(provider.calls.filter(call => call.path === '/api/pull').length, 1);
  release.resolve();
  await completion;
  assert.equal(setup.getStatus().phase, 'ready');
  assert.equal(provider.calls.filter(call => call.path === '/api/pull').length, 1);
});

test('download and verification use the current configured model and provider base URL', async t => {
  let selectedModel = DEFAULT_MODEL;
  const provider = await fixture(t, {
    basePath: '/configured-provider',
    pull(response, call, state) {
      assert.equal(call.method, 'POST');
      assert.deepEqual(call.body, { model: 'llama3.2:1b', stream: true });
      state.models = [{ name: call.body.model }];
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end('{"status":"success"}\n');
    },
  });
  const { setup } = provider.setup({ getModel: () => selectedModel });
  selectedModel = 'llama3.2:1b';
  setup.start();
  await setup.waitUntilSettled();
  assert.equal(setup.getStatus().phase, 'ready');
  assert.equal(setup.getStatus().model, selectedModel);
  assert.deepEqual(provider.calls.map(call => call.path), [
    '/configured-provider/api/version', '/configured-provider/api/tags',
    '/configured-provider/api/pull', '/configured-provider/api/tags',
  ]);
});

test('an unreachable service reports the missing prerequisite and does not attempt a pull', async t => {
  const provider = await fixture(t, { versionStatus: 503 });
  const { setup, statuses } = provider.setup();
  setup.start();
  await setup.waitUntilSettled();
  assert.equal(setup.getStatus().phase, 'error');
  assert.match(setup.getStatus().error, /Ollama is not running/);
  assert.deepEqual(provider.calls.map(call => call.path), ['/api/version']);
  assert.ok(!statuses.some(status => status.phase === 'ready'));
});

test('malformed progress is rejected without marking the model ready', async t => {
  const provider = await fixture(t, {
    pull(response) {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end('{not valid JSON}\n');
    },
  });
  const { setup, statuses } = provider.setup();
  setup.start();
  await setup.waitUntilSettled();
  assert.equal(setup.getStatus().phase, 'error');
  assert.match(setup.getStatus().error, /invalid download progress/);
  assert.ok(!statuses.some(status => status.phase === 'ready'));
});

test('an idle stream is aborted with an actionable retry message', { timeout: 5000 }, async t => {
  const provider = await fixture(t, {
    pull(response) {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write('{"status":"pulling manifest"}\n');
      // Leave the stream open indefinitely; the module must enforce its idle deadline.
    },
  });
  const { setup, statuses } = provider.setup({ idleTimeoutMs: 100 });
  setup.start();
  await setup.waitUntilSettled();
  assert.equal(setup.running, false);
  assert.equal(setup.getStatus().phase, 'error');
  assert.match(setup.getStatus().error, /stopped responding.*retry.*resume/i);
  assert.ok(!statuses.some(status => status.phase === 'ready'));
});
