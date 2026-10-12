import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import voice from '../desktop/voice.cjs';

const { createVoiceManager, RELEASES, MODELS, fetchModelMetadata, modelArtifact, downloadVerified, validateWav, runProcess } = voice;
const revision = 'ab'.repeat(20);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function wav({ rate = 16000, seconds = 0.1, channels = 1, amplitude = 800 } = {}) {
  const length = Math.round(rate * seconds) * 2 * channels;
  const bytes = Buffer.alloc(44 + length);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(length, 40);
  for (let offset = 44; offset < bytes.length; offset += 2) bytes.writeInt16LE(amplitude, offset);
  return bytes;
}

function streamedResponse(bytes) {
  // Exercise streaming verification across multiple chunks rather than arrayBuffer shortcuts.
  return new Response(new ReadableStream({
    start(controller) {
      const middle = Math.ceil(bytes.length / 2);
      controller.enqueue(bytes.subarray(0, middle));
      controller.enqueue(bytes.subarray(middle));
      controller.close();
    },
  }), { headers: { 'content-length': String(bytes.length) } });
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-voice-'quoted-"));
  const calls = { fetch: [], run: [], statuses: [] };
  const managers = [];
  const payloads = {
    whisper: Buffer.from('verified whisper fixture model'),
    piper: Buffer.from('verified British English voice fixture model'),
    config: Buffer.from(JSON.stringify({ audio: { sample_rate: 22050 }, espeak: { voice: 'en-gb' }, phoneme_id_map: { _: [0] } })),
    card: Buffer.from('Fixture British voice model card and license attribution.'),
  };
  const archives = { whisper: Buffer.from('trusted whisper fixture zip'), piper: Buffer.from('trusted piper fixture zip') };
  const releases = Object.fromEntries(Object.entries(RELEASES).map(([name, release]) => [name, { ...release, sha256: sha256(archives[name]) }]));
  const cardPath = 'en/en_GB/alan/medium/MODEL_CARD';
  const metadata = {
    whisper: { sha: revision, siblings: [{ rfilename: MODELS.whisper.path, lfs: { sha256: sha256(payloads.whisper), size: payloads.whisper.length } }] },
    piper: { sha: revision, siblings: [
      { rfilename: MODELS.piper.path, lfs: { oid: sha256(payloads.piper), size: payloads.piper.length } },
      { rfilename: MODELS.config.path, blobId: gitBlob(payloads.config), size: payloads.config.length },
      { rfilename: cardPath, blobId: gitBlob(payloads.card), size: payloads.card.length },
    ] },
  };
  const fakeFetch = async (url, init) => {
    calls.fetch.push(url);
    if (overrides.fetch) {
      const response = await overrides.fetch(url, init, { metadata, payloads, archives });
      if (response !== undefined) return response;
    }
    if (url === `https://huggingface.co/api/models/${MODELS.whisper.repo}?blobs=true`) return Response.json(metadata.whisper);
    if (url === `https://huggingface.co/api/models/${MODELS.piper.repo}?blobs=true`) return Response.json(metadata.piper);
    for (const name of ['whisper', 'piper']) if (url === releases[name].url) return streamedResponse(archives[name]);
    for (const [name, model] of Object.entries(MODELS)) {
      if (url === `https://huggingface.co/${model.repo}/resolve/${revision}/${model.path}`) return streamedResponse(payloads[name]);
    }
    if (url === `https://huggingface.co/${MODELS.piper.repo}/resolve/${revision}/${cardPath}`) return streamedResponse(payloads.card);
    throw new Error('Unexpected download: ' + url);
  };
  const fakeRun = async (executable, args, init = {}) => {
    const call = { executable, args, init };
    calls.run.push(call);
    if (overrides.run) {
      const result = await overrides.run(call);
      if (result !== undefined) return result;
    }
    if (executable.endsWith('powershell.exe')) {
      const command = args[args.length - 1];
      const destination = command.match(/-DestinationPath '((?:[^']|'')*)'/)?.[1].replace(/''/g, "'");
      assert.ok(destination, 'Extraction passes a safely quoted literal destination');
      const name = destination.endsWith('whisper') ? 'whisper' : 'piper';
      const binary = join(destination, releases[name].executable);
      await mkdir(join(binary, '..'), { recursive: true });
      await writeFile(binary, `${name} executable fixture`);
      await writeFile(join(binary, '..', 'runtime.dll'), `${name} dependency fixture`);
      if (name === 'piper') {
        await mkdir(join(binary, '..', 'espeak-ng-data'));
        await writeFile(join(binary, '..', 'espeak-ng-data', 'phondata'), 'required phoneme data fixture');
      }
    } else if (args[0] === '--help') {
      await readFile(executable); // A probe cannot succeed unless extraction produced the executable.
    } else if (executable.endsWith('whisper-cli.exe')) {
      const recording = args[args.indexOf('-f') + 1];
      validateWav(await readFile(recording));
      await writeFile(args[args.indexOf('-of') + 1] + '.txt', '[BLANK_AUDIO]\n Hello from offline listening. \n');
    } else if (executable.endsWith('piper.exe')) {
      await writeFile(args[args.indexOf('--output_file') + 1], wav({ rate: 22050 }));
    } else throw new Error('Unexpected executable: ' + executable);
    return { code: 0, stdout: 'fixture help', stderr: '' };
  };
  t.after(async () => {
    for (const manager of managers) manager.dispose();
    await Promise.all(managers.map(manager => manager.waitUntilSettled()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, calls, payloads, metadata, releases,
    manager(options = {}) {
      const manager = createVoiceManager({ dataDir: directory, platform: 'win32', releases, fetcher: fakeFetch, run: fakeRun, onStatus: status => calls.statuses.push(status), ...options });
      managers.push(manager);
      return manager;
    },
  };
}

test('trusted Hugging Face metadata pins exact revisions and validates LFS and Git blob checksums', async () => {
  const bytes = Buffer.from('small model config');
  const repo = 'rhasspy/piper-voices';
  let requested;
  const metadata = await fetchModelMetadata(repo, async url => {
    requested = url;
    return Response.json({ sha: revision, siblings: [
      { rfilename: 'voice.onnx', lfs: { sha256: 'd'.repeat(64), size: 1024 } },
      { rfilename: 'voice.onnx.json', blobId: gitBlob(bytes), size: bytes.length },
    ] });
  });
  assert.equal(requested, `https://huggingface.co/api/models/${repo}?blobs=true`);
  const model = modelArtifact(repo, 'voice.onnx', metadata);
  assert.equal(model.algorithm, 'sha256');
  assert.equal(model.digest, 'd'.repeat(64));
  assert.equal(model.url, `https://huggingface.co/${repo}/resolve/${revision}/voice.onnx`);
  assert.equal(modelArtifact(repo, 'voice.onnx.json', metadata).algorithm, 'git-sha1');
  for (const malformed of [
    { sha: 'main', siblings: [] },
    { sha: revision, siblings: null },
  ]) await assert.rejects(fetchModelMetadata(repo, async () => Response.json(malformed)), /pinned revision/);
  assert.throws(() => modelArtifact(repo, 'missing', metadata), /missing/);
  assert.throws(() => modelArtifact(repo, 'voice.onnx', { sha: revision, siblings: [{ rfilename: 'voice.onnx', lfs: { size: 1024 }, blobId: 'c'.repeat(40) }] }), /SHA256/);
  assert.throws(() => modelArtifact(repo, 'voice.onnx.json', { sha: revision, siblings: [{ rfilename: 'voice.onnx.json', size: 7 }] }), /Git blob/);
});

test('verified downloads reject altered or truncated files, preserve prior files, and require HTTPS', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-voice-hash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'model.bin');
  const original = Buffer.from('keep existing verified data');
  await writeFile(destination, original);
  const bytes = Buffer.from('new trusted data');
  const common = { url: 'https://huggingface.co/fixture', destination, size: bytes.length, digest: sha256(bytes) };
  await assert.rejects(downloadVerified({ ...common, fetcher: async () => streamedResponse(Buffer.from('x'.repeat(bytes.length))) }), /checksum/);
  assert.deepEqual(await readFile(destination), original);
  await assert.rejects(downloadVerified({ ...common, fetcher: async () => new Response(bytes.subarray(0, -1)) }), /checksum/);
  await assert.rejects(downloadVerified({ ...common, url: 'http://huggingface.co/fixture', fetcher: async () => { assert.fail('HTTP must not be fetched'); } }), /HTTPS/);
  assert.deepEqual(await readdir(directory), ['model.bin']);
  await downloadVerified({ ...common, algorithm: 'git-sha1', digest: gitBlob(bytes), fetcher: async () => streamedResponse(bytes) });
  assert.deepEqual(await readFile(destination), bytes);
});

test('setup serializes clicks, verifies every asset, preserves DLL/data trees, and probes both runtimes', async t => {
  const f = await fixture(t);
  const manager = f.manager();
  assert.equal(manager.setup().running, true);
  assert.equal(manager.setup().running, true);
  const pending = manager.waitUntilSettled();
  assert.strictEqual(manager.waitUntilSettled(), pending);
  await pending;
  assert.equal(manager.getStatus().phase, 'ready');
  assert.equal(manager.getStatus().progress, 100);
  assert.equal(f.calls.fetch.filter(url => url.includes('/api/models/')).length, 2);
  assert.equal(f.calls.fetch.filter(url => url.endsWith('.zip')).length, 2);
  assert.equal(f.calls.run.filter(call => call.args[0] === '--help').length, 2);
  assert.ok(f.calls.statuses.some(status => status.phase === 'downloading' && status.progress > 0 && status.progress < 100));
  const assets = join(f.directory, 'voice', 'assets');
  assert.equal((await readFile(join(assets, 'runtimes/whisper/Release/runtime.dll'))).toString(), 'whisper dependency fixture');
  assert.equal((await readFile(join(assets, 'runtimes/piper/piper/espeak-ng-data/phondata'))).toString(), 'required phoneme data fixture');
  assert.deepEqual(await readFile(join(assets, MODELS.whisper.file)), f.payloads.whisper);
  assert.ok((await readFile(join(assets, 'licenses/British-voice-MODEL_CARD.txt'))).length);
  const manifest = JSON.parse(await readFile(join(f.directory, 'voice', 'installation.json'), 'utf8'));
  assert.equal(manifest.models[0].revision, revision);
  assert.ok(manifest.files['runtimes/piper/piper/runtime.dll']);
  assert.ok(!(await readdir(join(f.directory, 'voice'))).some(file => file.startsWith('.install-')));
  const extraction = f.calls.run.find(call => call.executable.endsWith('powershell.exe'));
  assert.ok(extraction.args.at(-1).includes("''quoted-"), 'PowerShell literal quotes escape apostrophes');
});

test('a verified installation restores offline, while modified models cannot become ready', async t => {
  const f = await fixture(t);
  const installed = f.manager();
  installed.setup(); await installed.waitUntilSettled();
  assert.equal(installed.getStatus().phase, 'ready');
  const offline = f.manager({ fetcher: async () => { assert.fail('A verified installed voice must work offline'); } });
  await offline.waitUntilSettled();
  assert.equal(offline.getStatus().phase, 'ready');
  await writeFile(join(f.directory, 'voice', 'assets', MODELS.whisper.file), 'tampered model');
  const tampered = f.manager({ fetcher: async () => { throw new Error('Network unavailable'); } });
  await tampered.waitUntilSettled();
  assert.equal(tampered.getStatus().phase, 'idle');
  tampered.setup(); await tampered.waitUntilSettled();
  assert.equal(tampered.getStatus().phase, 'error');
  assert.match(tampered.getStatus().error, /Network unavailable/);
});

test('altered archives and altered model downloads never become ready or leave staging files', async t => {
  for (const artifact of ['archive', 'model']) {
    const f = await fixture(t, {
      fetch(url, init, { payloads, archives }) {
        if (artifact === 'archive' && url === RELEASES.whisper.url) return streamedResponse(Buffer.alloc(archives.whisper.length, 1));
        if (artifact === 'model' && url.endsWith('/ggml-base.bin')) return streamedResponse(Buffer.alloc(payloads.whisper.length, 2));
      },
    });
    const manager = f.manager();
    manager.setup(); await manager.waitUntilSettled();
    assert.equal(manager.getStatus().phase, 'error');
    assert.match(manager.getStatus().error, /checksum/);
    assert.ok(!f.calls.statuses.some(status => status.phase === 'ready'));
    assert.ok(!(await readdir(join(f.directory, 'voice'))).some(file => file.startsWith('.install-')));
    if (artifact === 'archive') assert.equal(f.calls.run.length, 0, 'Unverified archives must never be extracted or executed');
  }
});

test('transcription uses fixed Whisper arguments, filters blank audio, and cleans recordings', async t => {
  const f = await fixture(t);
  const manager = f.manager();
  manager.setup(); await manager.waitUntilSettled();
  const result = await manager.transcribe(wav(), 'en');
  assert.deepEqual(result, { text: 'Hello from offline listening.' });
  const call = f.calls.run.find(call => call.executable.endsWith('whisper-cli.exe') && call.args[0] !== '--help');
  assert.equal(call.args[call.args.indexOf('-l') + 1], 'en');
  assert.equal(call.args[call.args.indexOf('-t') + 1], '4');
  assert.ok(call.args.includes('-ng'));
  assert.ok(call.args.includes('-nt'));
  assert.ok(call.args.includes('-otxt'));
  await assert.rejects(readFile(call.args[call.args.indexOf('-f') + 1]), { code: 'ENOENT' });
  const count = f.calls.run.length;
  assert.deepEqual(await manager.transcribe(wav({ amplitude: 0 })), { text: '' });
  assert.equal(f.calls.run.length, count, 'Silent recordings do not invoke Whisper');
});

test('British speech passes text through stdin and returns validated WAV bytes without leftover files', async t => {
  const f = await fixture(t);
  const manager = f.manager();
  manager.setup(); await manager.waitUntilSettled();
  const text = "Good evening.\n\n ' & $(commands stay plain text)\t\0\r\nAll paragraphs should be spoken.";
  const result = await manager.synthesize(text);
  assert.ok(result.audio instanceof Uint8Array);
  assert.equal(validateWav(result.audio, { sampleRate: null }).sampleRate, 22050);
  const call = f.calls.run.find(call => call.executable.endsWith('piper.exe') && call.args[0] !== '--help');
  assert.equal(call.init.input, "Good evening. ' & $(commands stay plain text) All paragraphs should be spoken.\n");
  assert.equal(call.init.input.split('\n').length, 2, 'Piper receives one complete utterance and one terminating newline');
  assert.ok(!call.args.includes(text));
  assert.ok(call.args[call.args.indexOf('--model') + 1].endsWith('en_GB-alan-medium.onnx'));
  await assert.rejects(readFile(call.args[call.args.indexOf('--output_file') + 1]), { code: 'ENOENT' });
  assert.ok(!(await readdir(join(f.directory, 'voice'))).some(file => file.startsWith('.audio-')));
});

test('invalid, oversized, stereo, and non-16k recordings are rejected before any process runs', async t => {
  const f = await fixture(t);
  const manager = f.manager();
  const malformed = wav(); malformed.writeUInt32LE(malformed.length + 10, 40);
  for (const input of [Buffer.from('not wav'), wav({ rate: 22050 }), wav({ channels: 2 }), wav({ seconds: 45.01 }), malformed]) {
    await assert.rejects(manager.transcribe(input), /WAV|16 kHz|45 seconds|truncated/);
  }
  await assert.rejects(manager.transcribe(wav(), 'en; echo injected'), /language/);
  await assert.rejects(manager.synthesize('x'.repeat(4001)), /4000/);
  assert.equal(f.calls.run.length, 0);
});

test('DLL failures remain visible with Visual C++ repair guidance and retry can restore the voice', async t => {
  let failSynthesis = true;
  const f = await fixture(t, {
    run(call) {
      if (failSynthesis && call.executable.endsWith('piper.exe') && call.args[0] !== '--help') return { code: 3221225781, stderr: 'VCRUNTIME140.dll missing' };
    },
  });
  const manager = f.manager();
  manager.setup(); await manager.waitUntilSettled();
  await assert.rejects(manager.synthesize('Hello'), /Visual C\+\+/);
  assert.equal(manager.getStatus().phase, 'error');
  assert.match(manager.getStatus().error, /VCRUNTIME140\.dll/);
  assert.ok(!(await readdir(join(f.directory, 'voice'))).some(file => file.startsWith('.audio-')));
  failSynthesis = false;
  const downloads = f.calls.fetch.length;
  manager.setup(); await manager.waitUntilSettled();
  assert.equal(manager.getStatus().phase, 'ready');
  assert.equal(f.calls.fetch.length, downloads, 'Repair probes reuse verified installed assets');
});

test('unsupported platforms do not download Windows binaries', async t => {
  const f = await fixture(t);
  const manager = f.manager({ platform: 'linux' });
  manager.setup(); await manager.waitUntilSettled();
  assert.equal(manager.getStatus().phase, 'error');
  assert.match(manager.getStatus().error, /Windows/);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.run.length, 0);
});

test('the real subprocess runner sends plaintext through stdin, captures errors, and honours cancellation', { timeout: 5000 }, async () => {
  const input = "British voice text & $(not a command) 'quoted'\n";
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input });
  assert.equal(result.stdout, input);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stderr.write("runtime failed"); process.exit(7)']), /code 7.*runtime failed/);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  controller.abort(new Error('Cancelled test voice operation'));
  await assert.rejects(pending, /Cancelled test voice operation/);
});

test('voice operations reject overlapping requests instead of accumulating recordings', async t => {
  let entered;
  let release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const releasePromise = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {
    async run(call) {
      if (call.executable.endsWith('piper.exe') && call.args[0] !== '--help') {
        entered();
        await releasePromise;
      }
    },
  });
  const manager = f.manager();
  manager.setup(); await manager.waitUntilSettled();
  const first = manager.synthesize('Speak one reply at a time.');
  await enteredPromise;
  await assert.rejects(manager.transcribe(wav()), /current voice operation/);
  assert.equal(manager.setup().running, false);
  release();
  await first;
  assert.equal(manager.getStatus().phase, 'ready');
  assert.ok(!(await readdir(join(f.directory, 'voice'))).some(file => file.startsWith('.audio-')));
});

test('closing JARVIS aborts pending setup without extracting or executing assets', { timeout: 5000 }, async t => {
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, {
    fetch(url, init) {
      if (url.includes('/api/models/')) return new Promise((resolve, reject) => {
        started();
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        if (init.signal.aborted) reject(init.signal.reason);
      });
    },
  });
  const manager = f.manager();
  manager.setup();
  await startedPromise;
  manager.dispose();
  await manager.waitUntilSettled();
  assert.equal(manager.getStatus().phase, 'error');
  assert.match(manager.getStatus().error, /closed.*Reopen/);
  assert.equal(f.calls.run.length, 0);
  assert.ok(!(await readdir(join(f.directory, 'voice'))).some(file => file.startsWith('.install-')));
});
