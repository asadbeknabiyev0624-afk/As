const DEFAULT_MODEL = 'qwen2.5:1.5b';

function createAiSetup(options = {}) {
  const baseUrl = (options.baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const fetcher = options.fetcher || fetch;
  const getModel = options.getModel || (() => DEFAULT_MODEL);
  const onStatus = options.onStatus || (() => {});
  const requestTimeoutMs = options.requestTimeoutMs || 15000;
  const idleTimeoutMs = options.idleTimeoutMs || 120000;
  let state = { phase: 'idle', model: getModel(), status: 'Download your AI model to start conversation.', progress: null, error: null };
  let task;
  let controller;

  function publish(changes) {
    state = { ...state, ...changes };
    try { onStatus({ ...state }); } catch {}
  }

  function getStatus() {
    const model = getModel();
    if (!task && model !== state.model) {
      state = { phase: 'idle', model, status: 'Set up the selected AI model.', progress: null, error: null };
    }
    return { ...state };
  }

  async function request(path, signal, init = {}) {
    const response = await fetcher(baseUrl + path, {
      ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
    });
    if (!response.ok) {
      let detail;
      try { detail = (await response.json()).error; } catch {}
      throw new Error(typeof detail === 'string' ? detail.slice(0, 800) : 'Ollama returned HTTP ' + response.status + '.');
    }
    return response;
  }

  async function installed(model, signal) {
    const response = await request('/api/tags', signal);
    const data = await response.json();
    if (!Array.isArray(data.models)) throw new Error('Ollama returned an invalid model list. Restart Ollama and try again.');
    return data.models.some(entry => entry.name === model || entry.name === model + ':latest');
  }

  async function ensureService(signal) {
    if (options.ensureService) return options.ensureService(signal);
    try { await request('/api/version', signal); return true; } catch { return false; }
  }

  async function run(model, signal) {
    if (!(await ensureService(signal))) {
      throw new Error('Ollama is not running. Open the installed Ollama app, then press Retry AI setup. If it is not installed yet, choose Install Ollama.');
    }
    if (await installed(model, signal)) {
      publish({ phase: 'ready', status: model + ' is installed. JARVIS is ready to chat.', progress: 100, error: null });
      return;
    }
    publish({ phase: 'downloading', status: 'Downloading ' + model + '. Keep JARVIS open.', progress: null });
    let timer;
    const bumpTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller?.abort(new Error('The model download stopped responding. Check your internet connection and retry; Ollama can resume the download.')), idleTimeoutMs);
      timer.unref?.();
    };
    bumpTimeout();
    try {
      const response = await fetcher(baseUrl + '/api/pull', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }), signal,
      });
      if (!response.ok) {
        let detail;
        try { detail = (await response.json()).error; } catch {}
        throw new Error(typeof detail === 'string' ? detail.slice(0, 800) : 'Model download failed (HTTP ' + response.status + '). Check your internet connection and retry.');
      }
      if (!response.body) throw new Error('Ollama returned no download progress. Restart Ollama and retry.');
      const decoder = new TextDecoder();
      let pending = '';
      function line(raw) {
        if (!raw.trim()) return;
        let update;
        try { update = JSON.parse(raw); } catch { throw new Error('Ollama returned invalid download progress. Restart Ollama and retry.'); }
        if (update.error) throw new Error(String(update.error).slice(0, 800));
        const total = Number(update.total);
        const completed = Number(update.completed);
        let progress = state.progress;
        if (Number.isFinite(total) && total > 0 && Number.isFinite(completed)) {
          progress = Math.min(100, Math.max(0, Math.round(completed / total * 100)));
        }
        const status = typeof update.status === 'string' ? update.status.slice(0, 300) : 'Downloading AI model…';
        publish({ phase: 'downloading', status: status === 'success' ? 'Checking the installed model…' : status, progress });
      }
      for await (const chunk of response.body) {
        bumpTimeout();
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 65536) throw new Error('Ollama returned oversized download progress. Restart it and retry.');
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          line(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      }
      pending += decoder.decode();
      line(pending);
      if (!(await installed(model, signal))) throw new Error('Ollama finished the download but ' + model + ' is still missing. Press Retry AI setup.');
      publish({ phase: 'ready', status: model + ' is installed. JARVIS is ready to chat.', progress: 100, error: null });
    } finally { clearTimeout(timer); }
  }

  function start() {
    if (task) return { running: true, message: state.status };
    const model = getModel();
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(model)) {
      publish({ phase: 'error', error: 'Choose a valid conversation model in Settings.', status: 'AI setup could not start.', progress: null });
      return { running: false, error: state.error };
    }
    controller = new AbortController();
    publish({ phase: 'connecting', model, status: 'Connecting to Ollama…', progress: null, error: null });
    task = Promise.resolve().then(() => run(model, controller.signal)).catch(error => {
      const message = controller.signal.aborted && controller.signal.reason?.message ? controller.signal.reason.message
        : error.name === 'TimeoutError' ? 'Ollama took too long to respond. Restart Ollama and retry.'
        : error.message === 'fetch failed' ? 'Cannot reach Ollama or its model registry. Check that Ollama is open and internet access is available, then retry.'
        : error.message;
      publish({ phase: 'error', status: 'AI setup needs attention.', error: message, progress: null });
    }).finally(() => { task = undefined; controller = undefined; });
    return { running: true, message: state.status };
  }

  return {
    start, getStatus, get running() { return Boolean(task); },
    waitUntilSettled: () => task || Promise.resolve(),
    dispose: () => controller?.abort(new Error('JARVIS closed before AI setup finished. Reopen JARVIS and retry to resume.')),
  };
}

module.exports = { createAiSetup, DEFAULT_MODEL };
