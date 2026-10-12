const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } = require('node:fs/promises');
const { join, resolve, relative, sep } = require('node:path');

const RELEASES = {
  whisper: {
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.0/whisper-bin-x64.zip',
    sha256: '00c4304b6be363a224a4b69829df49009f74131df8c3ce6a5878b89a11cd26ef',
    executable: 'Release/whisper-cli.exe',
  },
  piper: {
    url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
    sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea',
    executable: 'piper/piper.exe',
  },
};
const MODELS = {
  whisper: { repo: 'ggerganov/whisper.cpp', path: 'ggml-base.bin', file: 'models/ggml-base.bin' },
  piper: { repo: 'rhasspy/piper-voices', path: 'en/en_GB/alan/medium/en_GB-alan-medium.onnx', file: 'models/en_GB-alan-medium.onnx' },
  config: { repo: 'rhasspy/piper-voices', path: 'en/en_GB/alan/medium/en_GB-alan-medium.onnx.json', file: 'models/en_GB-alan-medium.onnx.json' },
};
const MAX_RECORDING_BYTES = 1500000;
const REDISTRIBUTABLE = 'Install the Microsoft Visual C++ 2015–2022 x64 Redistributable, then retry voice setup.';

function abortError(signal) {
  if (signal?.aborted) throw signal.reason || new Error('Voice operation was cancelled.');
}

function safePath(directory, path) {
  if (typeof path !== 'string' || !path || path.includes('\\')) throw new Error('Invalid voice asset path.');
  const target = resolve(directory, path);
  if (!target.startsWith(resolve(directory) + sep)) throw new Error('Invalid voice asset path.');
  return target;
}

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Voice downloads require verified HTTPS URLs.');
  return url.href;
}

async function checkedResponse(fetcher, url, signal) {
  const response = await fetcher(httpsUrl(url), { signal });
  if (!response.ok) throw new Error(`Voice download returned HTTP ${response.status}. Check your internet connection and retry.`);
  if (response.url) httpsUrl(response.url);
  if (!response.body) throw new Error('The voice download returned an empty response. Retry setup.');
  return response;
}

async function readLimited(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('The voice download returned an oversized response.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function fetchModelMetadata(repo, fetcher = fetch, signal) {
  const response = await checkedResponse(fetcher, `https://huggingface.co/api/models/${repo}?blobs=true`, signal);
  let metadata;
  try { metadata = JSON.parse((await readLimited(response, 4 * 1024 * 1024)).toString('utf8')); }
  catch (error) { throw new Error(`Cannot read trusted voice-model metadata: ${error.message}`); }
  if (!/^[a-f0-9]{40}$/i.test(metadata.sha || '') || !Array.isArray(metadata.siblings)) {
    throw new Error('Hugging Face did not provide a pinned revision and file checksums. Voice setup cannot safely continue.');
  }
  return metadata;
}

function modelArtifact(repo, path, metadata) {
  if (!/^[a-f0-9]{40}$/i.test(metadata.sha || '')) throw new Error('Missing trusted voice-model revision.');
  const sibling = metadata.siblings?.find(entry => entry?.rfilename === path);
  if (!sibling) throw new Error(`Trusted metadata is missing ${path}. Retry voice setup later.`);
  const size = sibling.lfs ? sibling.lfs.size : sibling.size;
  let algorithm;
  let digest;
  if (sibling.lfs) {
    algorithm = 'sha256';
    digest = sibling.lfs.sha256 || sibling.lfs.oid;
    if (!/^[a-f0-9]{64}$/i.test(digest || '')) throw new Error(`Missing trusted SHA256 checksum for ${path}.`);
  } else {
    algorithm = 'git-sha1';
    digest = sibling.blobId;
    if (!/^[a-f0-9]{40}$/i.test(digest || '')) throw new Error(`Missing trusted Git blob checksum for ${path}.`);
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > 300 * 1024 * 1024) throw new Error(`Invalid trusted file size for ${path}.`);
  return {
    repo, path, revision: metadata.sha, algorithm, digest: digest.toLowerCase(), size,
    url: `https://huggingface.co/${repo}/resolve/${metadata.sha}/${path.split('/').map(encodeURIComponent).join('/')}`,
  };
}

async function downloadVerified({ url, destination, algorithm = 'sha256', digest, size, maxBytes = 300 * 1024 * 1024, fetcher = fetch, signal, onProgress = () => {} }) {
  const validDigest = algorithm === 'sha256' ? /^[a-f0-9]{64}$/i : algorithm === 'git-sha1' ? /^[a-f0-9]{40}$/i : null;
  if (!validDigest?.test(digest || '') || (algorithm === 'git-sha1' && !Number.isSafeInteger(size))) {
    throw new Error('A trusted checksum is required before downloading voice assets.');
  }
  await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
  const temporary = destination + '.' + randomUUID() + '.part';
  let handle;
  try {
    const response = await checkedResponse(fetcher, url, signal);
    const declared = Number(response.headers?.get('content-length'));
    if (declared > maxBytes || (size && declared > 0 && declared !== size)) throw new Error('Voice download size does not match its trusted metadata.');
    const hash = createHash(algorithm === 'git-sha1' ? 'sha1' : 'sha256');
    if (algorithm === 'git-sha1') hash.update(`blob ${size}\0`);
    handle = await open(temporary, 'wx', 0o600);
    let received = 0;
    for await (const chunk of response.body) {
      abortError(signal);
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      if (received > maxBytes || (size && received > size)) throw new Error('Voice download exceeded its trusted file size.');
      hash.update(bytes);
      await handle.writeFile(bytes);
      onProgress(size || declared > 0 ? Math.min(100, Math.round(received / (size || declared) * 100)) : null);
    }
    if ((size && received !== size) || !received || hash.digest('hex') !== digest.toLowerCase()) {
      throw new Error('Voice asset checksum verification failed. The file was discarded; retry setup.');
    }
    await handle.close();
    handle = undefined;
    abortError(signal);
    await rename(temporary, destination);
    return received;
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function hashFile(file, signal) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file, { signal })) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}

async function inventory(directory, signal, prefix = '') {
  const files = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    abortError(signal);
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) Object.assign(files, await inventory(directory, signal, path));
    else if (entry.isFile()) files[path] = await hashFile(safePath(directory, path), signal);
    else throw new Error('Unexpected link or special file in the voice runtime.');
  }
  return files;
}

function processError(executable, code, detail = '') {
  const missingDll = [3221225781, -1073741515].includes(code) || /(?:vcruntime|msvcp|\.dll|0xc0000135)/i.test(detail);
  return new Error(`${executable.endsWith('whisper-cli.exe') ? 'Offline listening' : executable.endsWith('piper.exe') ? 'British voice' : 'Voice installation'} could not run${code == null ? '' : ` (code ${code})`}. ${missingDll ? REDISTRIBUTABLE : 'Retry voice setup. If it keeps failing, install the Microsoft Visual C++ 2015–2022 x64 Redistributable.'}${detail ? ' ' + detail.slice(0, 500) : ''}`);
}

function runProcess(executable, args, { input, cwd, signal, timeoutMs = 90000 } = {}) {
  return new Promise((resolveProcess, reject) => {
    abortError(signal);
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [] };
    let length = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      error ? reject(error) : resolveProcess(result);
    };
    const cancelled = () => { child.kill(); finish(signal.reason || new Error('Voice operation was cancelled.')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Offline voice took too long. Try a shorter recording or reply.')); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', cancelled, { once: true });
    for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
      length += chunk.length;
      if (length > 1024 * 1024) { child.kill(); finish(new Error('The voice runtime returned too much output. Retry voice setup.')); }
      else output[channel].push(chunk);
    });
    child.once('error', error => finish(processError(executable, undefined, error.message)));
    child.once('close', code => {
      const stdout = Buffer.concat(output.stdout).toString('utf8');
      const stderr = Buffer.concat(output.stderr).toString('utf8');
      finish(code === 0 ? null : processError(executable, code, stderr), { code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    if (signal?.aborted) cancelled();
  });
}

function validateWav(input, { sampleRate = 16000, maxSeconds = 45, maxBytes = MAX_RECORDING_BYTES } = {}) {
  if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) throw new Error('Send a WAV recording as binary audio.');
  const bytes = input instanceof ArrayBuffer ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 44 || bytes.length > maxBytes || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error('The recording must be a valid WAV file under 45 seconds.');
  }
  let format;
  let audio;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw new Error('The WAV recording contains a truncated chunk.');
    if (type === 'fmt ') {
      if (format || size < 16) throw new Error('The WAV recording has an invalid audio format.');
      format = {
        encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        rate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8),
        alignment: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14),
      };
    }
    if (type === 'data') { if (audio) throw new Error('The WAV recording has multiple audio chunks.'); audio = bytes.subarray(start, start + size); }
    offset = start + size + (size % 2);
    if (offset > bytes.length || (offset < bytes.length && offset + 8 > bytes.length)) throw new Error('The WAV recording contains invalid trailing data.');
  }
  if (!format || !audio?.length || format.encoding !== 1 || format.channels !== 1 || format.bits !== 16 ||
      (sampleRate && format.rate !== sampleRate) || format.rate < 8000 || format.rate > 48000 ||
      format.alignment !== 2 || format.byteRate !== format.rate * 2 || audio.length % 2 || audio.length / format.byteRate > maxSeconds) {
    throw new Error(sampleRate ? 'Record mono PCM 16-bit audio at 16 kHz, for no more than 45 seconds.' : 'The voice runtime returned invalid WAV audio.');
  }
  return { bytes, audio, sampleRate: format.rate };
}

function createVoiceManager(options = {}) {
  if (!options.dataDir) throw new Error('A private data directory is required for offline voice.');
  const directory = join(resolve(options.dataDir), 'voice');
  const assets = join(directory, 'assets');
  const releases = options.releases || RELEASES;
  const fetcher = options.fetcher || fetch;
  const execute = options.run || runProcess;
  const platform = options.platform || process.platform;
  const onStatus = options.onStatus || (() => {});
  let state = { phase: 'idle', status: 'Download offline listening and a natural British English voice once.', progress: null, error: null };
  let task;
  let controller;
  let operation;
  let disposed = false;
  const restoreController = new AbortController();

  function publish(changes) { state = { ...state, ...changes }; try { onStatus({ ...state }); } catch {} }
  function fail(error) { publish({ phase: 'error', status: 'Offline voice needs attention.', progress: null, error: error.message || String(error) }); }
  const executable = (name, base = assets) => safePath(base, 'runtimes/' + name + '/' + releases[name].executable);
  const modelFile = (name, base = assets) => safePath(base, MODELS[name].file);

  async function invoke(file, args, init) {
    abortError(init?.signal);
    const result = await execute(file, args, init);
    abortError(init?.signal);
    if (result?.code != null && result.code !== 0) throw processError(file, result.code, result.stderr);
    return result;
  }

  async function probe(base, signal) {
    for (const name of ['whisper', 'piper']) {
      const file = executable(name, base);
      let exists;
      try { exists = (await stat(file)).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!exists) throw new Error('An offline voice executable is missing. Retry voice setup.');
      await invoke(file, ['--help'], { cwd: resolve(file, '..'), signal, timeoutMs: 20000 });
    }
  }

  async function verifyExisting(signal) {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(directory, 'installation.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    if (manifest.version !== 1 || manifest.releases?.whisper !== releases.whisper.sha256 || manifest.releases?.piper !== releases.piper.sha256 || !manifest.files || typeof manifest.files !== 'object') return false;
    const required = ['whisper', 'piper'].map(name => 'runtimes/' + name + '/' + releases[name].executable).concat(Object.values(MODELS).map(model => model.file));
    if (required.some(path => !manifest.files[path])) return false;
    try {
      for (const [path, expected] of Object.entries(manifest.files)) {
        if (!/^[a-f0-9]{64}$/i.test(expected?.sha256 || '') || !Number.isSafeInteger(expected.size)) return false;
        const actual = await hashFile(safePath(assets, path), signal);
        if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) return false;
      }
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    await probe(assets, signal);
    return true;
  }

  const restoring = platform === 'win32' ? Promise.resolve().then(async () => {
    try { if (await verifyExisting(restoreController.signal) && !disposed && !task) publish({ phase: 'ready', status: 'Offline listening and the British English voice are ready.', progress: 100, error: null }); }
    catch (error) { if (!disposed) fail(error); }
  }) : Promise.resolve();

  async function install(signal) {
    await restoring;
    abortError(signal);
    if (platform !== 'win32') throw new Error('This offline voice package requires Windows 64-bit.');
    if (await verifyExisting(signal)) {
      publish({ phase: 'ready', status: 'Offline listening and the British English voice are ready.', progress: 100, error: null });
      return;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stage = join(directory, '.install-' + randomUUID());
    await mkdir(stage, { mode: 0o700 });
    try {
      const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
      const metadataResults = await Promise.allSettled([
        fetchModelMetadata(MODELS.whisper.repo, fetcher, metadataSignal),
        fetchModelMetadata(MODELS.piper.repo, fetcher, metadataSignal),
      ]);
      const failedMetadata = metadataResults.find(result => result.status === 'rejected');
      if (failedMetadata) throw failedMetadata.reason;
      const [whisperMetadata, piperMetadata] = metadataResults.map(result => result.value);
      const models = Object.entries(MODELS).map(([name, model]) => ({ name, ...model, artifact: modelArtifact(model.repo, model.path, name === 'whisper' ? whisperMetadata : piperMetadata) }));
      let index = 0;
      const download = async (url, destination, verification, label) => {
        publish({ phase: 'downloading', status: label, progress: Math.round(index / 5 * 95), error: null });
        await downloadVerified({ url, destination, ...verification, fetcher,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]),
          onProgress: percent => publish({ progress: percent == null ? null : Math.round((index + percent / 100) / 5 * 95) }),
        });
        index++;
      };
      for (const name of ['whisper', 'piper']) {
        const release = releases[name];
        const archive = join(stage, name + '.zip');
        await download(release.url, archive, { digest: release.sha256, maxBytes: 150 * 1024 * 1024 }, 'Downloading the ' + (name === 'whisper' ? 'offline listening' : 'British voice') + ' runtime…');
        const destination = join(stage, 'runtimes', name);
        const quote = value => "'" + value.replace(/'/g, "''") + "'";
        const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        await invoke(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath ' + quote(archive) + ' -DestinationPath ' + quote(destination) + ' -Force'], { signal, timeoutMs: 90000 });
        await rm(archive, { force: true });
      }
      await probe(stage, signal);
      for (const model of models) await download(model.artifact.url, modelFile(model.name, stage), model.artifact, 'Downloading ' + (model.name === 'whisper' ? 'the multilingual listening model' : model.name === 'piper' ? 'the natural British English voice' : 'the voice configuration') + '…');
      let config;
      try { config = JSON.parse(await readFile(modelFile('config', stage), 'utf8')); }
      catch { throw new Error('The verified British voice configuration is invalid. Retry setup.'); }
      if (!config.audio?.sample_rate || !config.phoneme_id_map || !config.espeak?.voice) throw new Error('The British voice configuration is incomplete. Retry setup.');
      const cardPath = 'en/en_GB/alan/medium/MODEL_CARD';
      if (piperMetadata.siblings.some(entry => entry?.rfilename === cardPath)) {
        const card = modelArtifact(MODELS.piper.repo, cardPath, piperMetadata);
        await downloadVerified({ ...card, destination: join(stage, 'licenses', 'British-voice-MODEL_CARD.txt'), fetcher, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), maxBytes: 1024 * 1024 });
      }
      await writeFile(join(stage, 'NOTICES.txt'), 'Offline voice components and licensing sources:\n\nwhisper.cpp (MIT): https://github.com/ggml-org/whisper.cpp/tree/v1.9.0\nWhisper models (MIT): https://huggingface.co/ggerganov/whisper.cpp\nPiper: https://github.com/rhasspy/piper/tree/2023.11.14-2\nBundled eSpeak NG: https://github.com/espeak-ng/espeak-ng\nAlan British English voice: https://huggingface.co/rhasspy/piper-voices/tree/' + piperMetadata.sha + '/en/en_GB/alan/medium\nSee the included model card and runtime notices for component-specific terms.\n', { mode: 0o600 });
      abortError(signal);
      const files = await inventory(stage, signal);
      const manifest = { version: 1, releases: { whisper: releases.whisper.sha256, piper: releases.piper.sha256 }, models: models.map(model => model.artifact), files };
      const previous = join(directory, '.previous-' + randomUUID());
      let movedPrevious = false;
      try {
        try { await rename(assets, previous); movedPrevious = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rename(stage, assets);
        try {
          const temporary = join(directory, 'installation.' + randomUUID() + '.json');
          await writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
          await rename(temporary, join(directory, 'installation.json'));
        } catch (error) {
          await rm(assets, { recursive: true, force: true });
          if (movedPrevious) await rename(previous, assets);
          throw error;
        }
      } catch (error) {
        if (movedPrevious) {
          try { await stat(assets); } catch (missing) { if (missing.code === 'ENOENT') await rename(previous, assets); }
        }
        throw error;
      }
      await rm(previous, { recursive: true, force: true }).catch(() => {});
      publish({ phase: 'ready', status: 'Offline listening and the natural British English voice are ready.', progress: 100, error: null });
    } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
  }

  function setup() {
    if (task) return { running: true, message: state.status };
    if (disposed) return { running: false, message: 'Reopen JARVIS to set up offline voice.' };
    if (operation) return { running: false, message: 'Wait for the current voice operation, then retry setup.' };
    controller = new AbortController();
    publish({ phase: 'downloading', status: 'Checking the offline voice package…', progress: 0, error: null });
    task = Promise.resolve().then(() => install(controller.signal)).catch(error => fail(controller.signal.aborted ? controller.signal.reason : error)).finally(() => { task = undefined; controller = undefined; });
    return { running: true, message: state.status };
  }

  async function withRuntime(work) {
    await restoring;
    if (disposed) throw new Error('JARVIS is closing. Reopen it before using offline voice.');
    if (task || state.phase !== 'ready') throw new Error('Set up offline voice in Settings before using it.');
    if (operation) throw new Error('Wait for the current voice operation to finish.');
    const active = new AbortController();
    operation = active;
    const temporary = join(directory, '.audio-' + randomUUID());
    try {
      await mkdir(temporary, { mode: 0o700 });
      return await work(temporary, active.signal);
    } catch (error) {
      fail(active.signal.aborted ? active.signal.reason : error);
      throw error;
    } finally { operation = undefined; await rm(temporary, { recursive: true, force: true }).catch(() => {}); }
  }

  async function transcribe(input, language = 'en') {
    const wav = validateWav(input);
    if (typeof language !== 'string' || !/^(?:auto|[a-z]{2,3})$/.test(language)) throw new Error('Choose a valid listening language.');
    let silent = true;
    for (let offset = 0; offset < wav.audio.length; offset += 2) if (Math.abs(wav.audio.readInt16LE(offset)) > 8) { silent = false; break; }
    if (silent) return { text: '' };
    return withRuntime(async (temporary, signal) => {
      const recording = join(temporary, 'recording.wav');
      const output = join(temporary, 'transcript');
      await writeFile(recording, wav.bytes, { mode: 0o600 });
      await invoke(executable('whisper'), ['-m', modelFile('whisper'), '-f', recording, '-l', language, '-t', '4', '-ng', '-otxt', '-of', output, '-nt', '-np'], { signal, cwd: resolve(executable('whisper'), '..'), timeoutMs: 120000 });
      const result = await readFile(output + '.txt', 'utf8');
      const text = result.split(/\r?\n/).filter(line => !/^\s*\[(?:BLANK_AUDIO|SILENCE|NO_SPEECH|MUSIC)\]\s*$/i.test(line)).join('\n').trim();
      if (text.length > 12000) throw new Error('The listening runtime returned too much text. Try a shorter recording.');
      return { text };
    });
  }

  async function synthesize(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Spoken replies must contain 1 to 4000 characters.');
    // This Piper CLI treats each stdin line as a separate utterance and reuses
    // --output_file, so paragraphs must become one line before synthesis.
    const utterance = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ');
    if (!utterance) throw new Error('Spoken replies must contain readable text.');
    return withRuntime(async (temporary, signal) => {
      const output = join(temporary, 'reply.wav');
      await invoke(executable('piper'), ['--model', modelFile('piper'), '--output_file', output], { input: utterance + '\n', signal, cwd: resolve(executable('piper'), '..'), timeoutMs: 120000 });
      const info = await stat(output);
      if (info.size > 30 * 1024 * 1024) throw new Error('The British voice returned oversized audio. Try a shorter reply.');
      const wav = validateWav(await readFile(output), { sampleRate: null, maxSeconds: 600, maxBytes: 30 * 1024 * 1024 });
      return { audio: new Uint8Array(wav.bytes) };
    });
  }

  return {
    getStatus: () => ({ ...state }), setup, waitUntilSettled: () => task || restoring,
    transcribe, synthesize,
    dispose() { disposed = true; const error = new Error('JARVIS closed before offline voice finished. Reopen it and retry.'); restoreController.abort(error); controller?.abort(error); operation?.abort(error); },
  };
}

module.exports = { createVoiceManager, RELEASES, MODELS, MAX_RECORDING_BYTES, fetchModelMetadata, modelArtifact, downloadVerified, validateWav, runProcess };
