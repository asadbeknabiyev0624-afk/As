import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle, ArrowUp, ArrowUpRight, Bell, Brain, Check, CheckCircle2,
  ChevronRight, Clock3, Cpu, Download, LayoutDashboard, ListTodo,
  LoaderCircle, LockKeyhole, Menu, MessageSquare, Mic, MicOff, Plus,
  RefreshCw, Settings2, ShieldCheck, Sparkles, Trash2, Volume2, VolumeX,
  WifiOff, X,
} from 'lucide-react'

const NAV = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'conversation', label: 'Conversation', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
  { id: 'settings', label: 'Settings', icon: Settings2 },
]
const CACHE_KEY = 'jarvis-state-v1'
const TOKEN_KEY = 'jarvis-access-token'
const MODEL = 'qwen2.5:1.5b'

function readCache() {
  try {
    const data = JSON.parse(localStorage.getItem(CACHE_KEY))
    return data?.profile && Array.isArray(data.messages) && Array.isArray(data.notes) && Array.isArray(data.tasks) ? data : null
  } catch { return null }
}

async function request(path, options = {}) {
  let token = localStorage.getItem(TOKEN_KEY)
  if (window.JarvisDesktop) {
    token = await window.JarvisDesktop.getAccessToken()
    localStorage.setItem(TOKEN_KEY, token)
  }
  let response
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Jarvis-Token': token } : {}), ...options.headers },
    })
  } catch {
    const error = new Error('The companion server is unavailable. Start the server, then reconnect.')
    error.network = true
    throw error
  }
  let data
  try { data = await response.json() } catch {
    const error = new Error('The companion server did not return a valid response. Check that the backend is running.')
    error.network = true
    throw error
  }
  if (!response.ok) {
    const error = new Error(data.error || `The request could not be completed (${response.status}).`)
    error.status = response.status
    error.state = data.state
    throw error
  }
  return data
}

function Orb({ small = false, listening = false }) {
  return <div className={`orb ${small ? 'orb-small' : ''} ${listening ? 'orb-listening' : ''}`} aria-hidden="true">
    <div className="orb-halo" /><div className="orb-ring orb-ring-outer" /><div className="orb-ring orb-ring-middle" />
    <div className="orb-ring orb-ring-inner" /><div className="orb-core"><div className="orb-core-light" /><span>J</span></div>
    <span className="orb-tick tick-one" /><span className="orb-tick tick-two" /><span className="orb-tick tick-three" />
  </div>
}

function SectionHeading({ eyebrow, title, children }) {
  return <div className="section-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>{children}</div>
}

function Empty({ icon: Icon, title, description }) {
  return <div className="empty"><span className="empty-icon"><Icon size={23} /></span><h3>{title}</h3><p>{description}</p></div>
}

function App() {
  const [state, setState] = useState(null)
  const [status, setStatus] = useState(null)
  const [view, setView] = useState('overview')
  const [loading, setLoading] = useState(true)
  const [networkAvailable, setNetworkAvailable] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [pendingMessage, setPendingMessage] = useState('')
  const [speaking, setSpeaking] = useState(() => localStorage.getItem('jarvis-speak') === 'true')
  const [listening, setListening] = useState(false)
  const [voiceError, setVoiceError] = useState('')
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [installPrompt, setInstallPrompt] = useState(null)
  const [mobileMenu, setMobileMenu] = useState(false)
  const recognition = useRef(null)
  const composerRef = useRef(null)
  const messageEnd = useRef(null)
  const notified = useRef(new Set())
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    const results = await Promise.allSettled([request('/state'), request('/status')])
    if (!mounted.current) return
    const [stateResult, statusResult] = results
    if (stateResult.status === 'fulfilled') {
      setState(stateResult.value.state || stateResult.value)
      setNetworkAvailable(true)
      setAuthRequired(false)
    } else {
      setNetworkAvailable(false)
      setAuthRequired(stateResult.reason.status === 401)
      setError(stateResult.reason.message)
      if (stateResult.reason.status === 401) {
        localStorage.removeItem(CACHE_KEY)
        setState(null)
      } else setState(previous => previous || readCache())
    }
    if (statusResult.status === 'fulfilled') setStatus(statusResult.value)
    else setStatus({ online: false, modelAvailable: false, models: [], error: statusResult.reason.message })
    setLoading(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    refresh()
    return () => { mounted.current = false }
  }, [refresh])

  useEffect(() => {
    if (state && networkAvailable) localStorage.setItem(CACHE_KEY, JSON.stringify(state))
  }, [state, networkAvailable])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const handler = event => { event.preventDefault(); setInstallPrompt(event) }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  useEffect(() => {
    if (window.JarvisAndroid?.startListening) {
      setVoiceSupported(true)
      const transcript = event => {
        setListening(false)
        if (event.detail?.text) setInput(previous => previous ? `${previous} ${event.detail.text}` : event.detail.text)
        composerRef.current?.focus()
      }
      const failure = event => { setListening(false); setVoiceError(event.detail?.message || 'Voice input could not finish. You can still type your message.') }
      const voiceState = event => setListening(Boolean(event.detail?.listening))
      window.addEventListener('jarvis-transcript', transcript)
      window.addEventListener('jarvis-voice-error', failure)
      window.addEventListener('jarvis-voice-state', voiceState)
      recognition.current = {
        start: () => { setListening(true); setVoiceError(''); window.JarvisAndroid.startListening() },
        stop: () => { window.JarvisAndroid.stopListening?.(); setListening(false) },
      }
      return () => {
        window.removeEventListener('jarvis-transcript', transcript)
        window.removeEventListener('jarvis-voice-error', failure)
        window.removeEventListener('jarvis-voice-state', voiceState)
        window.JarvisAndroid.stopListening?.()
        recognition.current = null
      }
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    setVoiceSupported(Boolean(SpeechRecognition))
    if (!SpeechRecognition) return
    const instance = new SpeechRecognition()
    instance.lang = navigator.language || 'en-US'
    instance.interimResults = false
    instance.onresult = event => {
      const transcript = Array.from(event.results).map(result => result[0].transcript).join(' ')
      setInput(previous => previous ? `${previous} ${transcript}` : transcript)
      composerRef.current?.focus()
    }
    instance.onstart = () => { setListening(true); setVoiceError('') }
    instance.onend = () => setListening(false)
    instance.onerror = event => {
      setListening(false)
      const errors = {
        'not-allowed': 'Microphone access was denied. Allow it in your browser settings, or type your message.',
        'audio-capture': 'No microphone was found. Connect a microphone, or type your message.',
        'network': 'Voice recognition could not connect. Your browser may need an internet connection for dictation.',
        'no-speech': 'No speech was detected. Try again when you’re ready.',
        'service-not-allowed': 'Voice recognition is unavailable in this browser. You can still type your message.',
      }
      if (event.error !== 'aborted') setVoiceError(errors[event.error] || 'Voice recognition could not finish. Please try again or type your message.')
    }
    recognition.current = instance
    return () => { instance.abort(); recognition.current = null }
  }, [])

  useEffect(() => {
    localStorage.setItem('jarvis-speak', String(speaking))
    if (!speaking && 'speechSynthesis' in window) window.speechSynthesis.cancel()
    if (!speaking) window.JarvisAndroid?.stopSpeaking?.()
  }, [speaking])

  useEffect(() => {
    if (!networkAvailable) return
    const timer = setInterval(() => {
      Promise.all([request('/state'), request('/status')]).then(([nextState, nextStatus]) => {
        if (!mounted.current) return
        setState(nextState.state || nextState)
        setStatus(nextStatus)
      }).catch(failure => {
        if (!mounted.current) return
        setNetworkAvailable(false)
        setStatus({ online: false, modelAvailable: false, models: [], error: failure.message })
        if (failure.status === 401) {
          localStorage.removeItem(CACHE_KEY)
          setState(null)
          setAuthRequired(true)
        }
        setError(failure.message)
      })
    }, 30000)
    return () => clearInterval(timer)
  }, [networkAvailable])

  const mutate = useCallback(async (path, method, body, success) => {
    if (!networkAvailable) { setError('Reconnect to the companion server to make changes. Your saved information is available to read.'); return null }
    try {
      const result = await request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      if (result.state) setState(result.state)
      setError('')
      if (success) setToast(success)
      return result
    } catch (failure) {
      if (failure.state) setState(failure.state)
      if (failure.network) setNetworkAvailable(false)
      if (failure.status === 401) {
        localStorage.removeItem(CACHE_KEY)
        setState(null)
        setNetworkAvailable(false)
        setAuthRequired(true)
      }
      setError(failure.message)
      return null
    }
  }, [networkAvailable])

  useEffect(() => {
    if (!state || !networkAvailable || !('Notification' in window)) return
    const check = () => {
      if (Notification.permission !== 'granted') return
      state.tasks.forEach(async task => {
        if (!task.dueAt || task.completed || task.notifiedAt || notified.current.has(task.id) || new Date(task.dueAt).getTime() > Date.now()) return
        notified.current.add(task.id)
        const result = await mutate(`/tasks/${encodeURIComponent(task.id)}`, 'PATCH', { notifiedAt: new Date().toISOString() })
        if (result) {
          try {
            const options = { body: task.title, icon: '/icon.svg', tag: task.id }
            const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null
            if (registration) await registration.showNotification('JARVIS · A little reminder', options)
            else new Notification('JARVIS · A little reminder', options)
          } catch { setToast(`Reminder: ${task.title}`) }
        } else {
          notified.current.delete(task.id)
        }
      })
    }
    check()
    const timer = setInterval(check, 30000)
    return () => clearInterval(timer)
  }, [state, networkAvailable, mutate])

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [state?.messages?.length, busy, view])

  function navigate(next) {
    setView(next)
    setMobileMenu(false)
    setVoiceError('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function sendMessage(event) {
    event?.preventDefault()
    const message = input.trim()
    if (!message || busy || !networkAvailable) return
    recognition.current?.stop()
    setBusy(true)
    setPendingMessage(message)
    setError('')
    const result = await mutate('/chat', 'POST', { message })
    if (result) {
      setInput('')
      if (speaking && window.JarvisAndroid?.speak && result.reply) {
        window.JarvisAndroid.speak(result.reply)
      } else if (speaking && 'speechSynthesis' in window && result.reply) {
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(result.reply)
        utterance.rate = 1
        utterance.onerror = event => { if (!['interrupted', 'canceled'].includes(event.error)) setVoiceError('The spoken response could not play. The text response is still available.') }
        window.speechSynthesis.speak(utterance)
      }
    }
    setPendingMessage('')
    setBusy(false)
  }

  function usePrompt(prompt) {
    setInput(prompt)
    navigate('conversation')
    setTimeout(() => composerRef.current?.focus(), 50)
  }

  function toggleVoice() {
    if (!voiceSupported) { setVoiceError('Dictation is not supported in this browser. Try Chrome or Edge, or type your message.'); return }
    if (!window.isSecureContext) { setVoiceError('Microphone access requires HTTPS or a connection on this device. Type your message here.'); return }
    if (listening) recognition.current?.stop()
    else {
      try { recognition.current?.start() } catch { setVoiceError('The microphone is already starting. Wait a moment and try again.') }
    }
  }

  async function install() {
    if (!installPrompt) { setToast('To keep JARVIS close, use your browser’s “Install app” or “Add to Home Screen” option.'); return }
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  const firstName = state?.profile?.name?.trim().split(/\s+/)[0] || 'friend'
  const available = networkAvailable && status?.online && status?.modelAvailable
  const activeTasks = state?.tasks?.filter(task => !task.completed) || []
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date())

  if (!state) return <div className="connection-screen"><div className="connection-panel">
    <Brand /><Orb />
    <p className="eyebrow">YOUR PERSONAL COMPANION</p>
    <h1>{loading ? 'Making a connection.' : authRequired ? 'Your companion is protected.' : 'Let’s get connected.'}</h1>
    <p>{loading ? 'Connecting to your JARVIS server…' : authRequired ? 'Enter the access token configured on your companion server. It stays in this browser.' : 'JARVIS needs its companion server to save your memories, manage tasks, and connect to your local AI.'}</p>
    {loading ? <LoaderCircle className="spin" size={24} /> : authRequired ? <Unlock onUnlock={refresh} /> : <>
      <div className="notice notice-error"><AlertCircle size={18} /><span>{error}</span></div>
      <button className="button button-primary" onClick={refresh}><RefreshCw size={16} /> Try connecting again</button>
      <p className="connection-help">From the project folder, run <code>npm run dev</code>. Install Ollama on your computer, then run <code>ollama pull qwen2.5:1.5b</code> to enable conversation.</p>
    </>}
    <span className="privacy-line"><ShieldCheck size={14} /> A local AI. A space that’s yours.</span>
  </div></div>

  return <div className="app-shell">
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
      <Brand />
      <div className="sidebar-divider" />
      <p className="nav-caption">YOUR SPACE</p>
      <nav aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? 'active' : ''}`} onClick={() => navigate(id)} aria-current={view === id ? 'page' : undefined}><Icon size={19} /><span>{label}</span>{id === 'tasks' && activeTasks.length > 0 && <span className="nav-count">{activeTasks.length}</span>}{view === id && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="companion-mini"><span className="mini-orb"><Sparkles size={16} /></span><div><strong>Always in your corner.</strong><p>A little help goes a long way.</p></div></div>
        <button className="install-button" onClick={install}><Download size={16} /><span>Keep JARVIS with you</span><ArrowUpRight size={14} /></button>
        <div className="profile-mini"><span className="avatar">{firstName[0].toUpperCase()}</span><div><strong>{state.profile.name || 'Your personal space'}</strong><p>Local companion</p></div><button className="icon-button" onClick={() => navigate('settings')} aria-label="Open profile settings"><Settings2 size={17} /></button></div>
      </div>
    </aside>
    {mobileMenu && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
    <main className="main">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={21} /></button><span className="breadcrumb">Your space <ChevronRight size={12} /> <strong>{NAV.find(item => item.id === view)?.label}</strong></span></div><div className="topbar-right"><span className="date-label">{date}</span><button className={`connection-pill ${available ? 'connected' : networkAvailable ? 'needs-setup' : 'disconnected'}`} onClick={() => navigate('settings')} title="View connection settings"><span />{available ? 'JARVIS connected' : networkAvailable ? 'Model needs setup' : 'Server offline'}</button><button className="icon-button notification-button" onClick={() => navigate('tasks')} aria-label="Open tasks and reminders"><Bell size={18} />{activeTasks.some(task => task.dueAt && new Date(task.dueAt) <= new Date()) && <span className="notification-dot" />}</button></div></header>
      <div className={`main-content page-${view}`}>
        {!networkAvailable && <div className="notice notice-warning"><WifiOff size={18} /><span>You’re viewing saved information. Reconnect to send messages or make changes.</span><button onClick={refresh} disabled={loading}>{loading ? 'Connecting…' : 'Reconnect'}</button></div>}
        {authRequired && <div className="unlock-banner"><LockKeyhole size={20} /><div><strong>The server needs an access token.</strong><Unlock onUnlock={refresh} /></div></div>}
        {error && networkAvailable && !authRequired && <div className="notice notice-error" role="alert"><AlertCircle size={18} /><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
        {view === 'overview' && <>
          <section className="hero"><div className="hero-copy"><p className="eyebrow"><span className="tiny-line" /> YOUR PERSONAL COMPANION</p><h1>Hello, {firstName}.<br /><span>What’s on your mind?</span></h1><p>A place to think out loud, find your next step,<br className="desktop-break" /> and make room for what matters.</p><button className="text-link" onClick={() => { navigate('conversation'); setTimeout(() => composerRef.current?.focus(), 50) }}>Let’s figure it out together <ArrowUpRight size={17} /></button></div><div className="hero-visual"><span className="orb-label orb-label-top">PERSONAL INTELLIGENCE</span><Orb listening={listening || busy} /><span className="orb-label orb-label-bottom"><span />{available ? 'Ready when you are' : 'Your space, ready to begin'}</span></div></section>
          <div className="dashboard-grid"><div className="dashboard-primary">
            <ChatCard state={state} input={input} setInput={setInput} sendMessage={sendMessage} busy={busy} pendingMessage={pendingMessage} networkAvailable={networkAvailable} listening={listening} toggleVoice={toggleVoice} voiceSupported={voiceSupported} voiceError={voiceError} speaking={speaking} setSpeaking={setSpeaking} composerRef={composerRef} messageEnd={messageEnd} compact onExpand={() => navigate('conversation')} />
            <section className="quick-section"><p className="eyebrow">A GOOD PLACE TO START</p><div className="quick-actions"><button onClick={() => usePrompt('Help me plan a realistic day. Ask about my priorities before making a plan.')}><span className="quick-icon"><ListTodo size={18} /></span><span>Plan my day<small>Find a little focus</small></span><ArrowUpRight size={16} /></button><button onClick={() => usePrompt('I have a decision to think through. Help me look at it clearly, and ask me what the decision is.')}><span className="quick-icon"><Sparkles size={18} /></span><span>Think it through<small>Get a fresh perspective</small></span><ArrowUpRight size={16} /></button><button onClick={() => navigate('memory')}><span className="quick-icon"><Brain size={18} /></span><span>Remember this<small>Keep something useful</small></span><ArrowUpRight size={16} /></button></div></section>
          </div><div className="dashboard-secondary">
            <TasksCard tasks={state.tasks} mutate={mutate} disabled={!networkAvailable} compact onExpand={() => navigate('tasks')} />
            <MemoryCard notes={state.notes} mutate={mutate} disabled={!networkAvailable} compact onExpand={() => navigate('memory')} />
            <div className="privacy-card"><ShieldCheck size={18} /><p>Your thoughts belong to you.<br /><span>Saved on your companion server.</span></p></div>
          </div></div>
          <footer className="page-footer"><span><span className="tiny-dot" /> MADE FOR YOUR EVERYDAY</span><span>A little more clarity, one conversation at a time.</span></footer>
        </>}
        {view === 'conversation' && <><SectionHeading eyebrow="THINK OUT LOUD" title="A conversation, just for you."><button className="button button-subtle" disabled={!networkAvailable || busy || !state.messages.length} onClick={async () => { if (window.confirm('Clear your saved conversation? Your memories and tasks will stay.')) await mutate('/messages', 'DELETE', undefined, 'Conversation cleared.') }}><Trash2 size={15} /> Clear conversation</button></SectionHeading><ChatCard state={state} input={input} setInput={setInput} sendMessage={sendMessage} busy={busy} pendingMessage={pendingMessage} networkAvailable={networkAvailable} listening={listening} toggleVoice={toggleVoice} voiceSupported={voiceSupported} voiceError={voiceError} speaking={speaking} setSpeaking={setSpeaking} composerRef={composerRef} messageEnd={messageEnd} /></>}
        {view === 'memory' && <><SectionHeading eyebrow="A LITTLE CONTEXT GOES A LONG WAY" title="The things worth remembering." /><p className="page-description">Keep useful details, ideas, and personal context. JARVIS can use these memories in your conversations.</p><MemoryCard notes={state.notes} mutate={mutate} disabled={!networkAvailable} /></>}
        {view === 'tasks' && <><SectionHeading eyebrow="ONE STEP AT A TIME" title="Make space for what matters." /><p className="page-description">A simple place for the things you want to do. No pressure to do it all at once.</p><TasksCard tasks={state.tasks} mutate={mutate} disabled={!networkAvailable} /><ReminderSettings onToast={setToast} /></>}
        {view === 'settings' && <><SectionHeading eyebrow="MAKE YOURSELF AT HOME" title="Your companion. Your way." /><Settings state={state} status={status} mutate={mutate} disabled={!networkAvailable} refresh={refresh} loading={loading} speaking={speaking} setSpeaking={setSpeaking} install={install} onToast={setToast} /></>}
      </div>
    </main>
    <nav className="mobile-nav" aria-label="Mobile navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)} className={view === id ? 'active' : ''} aria-current={view === id ? 'page' : undefined}><Icon size={20} /><span>{label === 'Conversation' ? 'Chat' : label}</span></button>)}</nav>
    {toast && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
  </div>
}

function Brand() {
  return <div className="brand"><div className="brand-mark"><span>J</span></div><div><strong>J.A.R.V.I.S<span>.</span></strong><p>YOUR PERSONAL COMPANION</p></div></div>
}

function Unlock({ onUnlock }) {
  const [token, setToken] = useState('')
  return <form className="unlock-form" onSubmit={event => { event.preventDefault(); if (!token.trim()) return; localStorage.setItem(TOKEN_KEY, token.trim()); onUnlock() }}><label className="sr-only" htmlFor="unlock-token">Server access token</label><input id="unlock-token" type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" placeholder="Server access token" required /><button className="button button-primary" type="submit"><LockKeyhole size={15} /> Unlock</button></form>
}

function ChatCard({ state, input, setInput, sendMessage, busy, pendingMessage, networkAvailable, listening, toggleVoice, voiceSupported, voiceError, speaking, setSpeaking, composerRef, messageEnd, compact, onExpand }) {
  const messages = compact ? state.messages.slice(-4) : state.messages
  return <section className={`card chat-card ${compact ? 'chat-compact' : 'chat-full'}`} aria-label="Conversation">
    <div className="card-heading"><div className="card-title"><span className="card-icon"><MessageSquare size={17} /></span><h2>{compact ? 'Your conversation' : 'JARVIS'}</h2><span className="label-pill">A listening ear</span></div><div className="chat-tools">{(window.JarvisAndroid?.speak || 'speechSynthesis' in window) && <button className={`icon-button ${speaking ? 'enabled' : ''}`} onClick={() => setSpeaking(!speaking)} aria-label={speaking ? 'Turn spoken replies off' : 'Turn spoken replies on'} aria-pressed={speaking} title={speaking ? 'Spoken replies on' : 'Spoken replies off'}>{speaking ? <Volume2 size={17} /> : <VolumeX size={17} />}</button>}{compact && <button className="icon-button" onClick={onExpand} aria-label="Open full conversation"><ArrowUpRight size={18} /></button>}</div></div>
    <div className="chat-messages" aria-live="polite" aria-busy={busy}>
      {!messages.length && !busy ? <div className="chat-welcome"><div className="welcome-mark"><Sparkles size={25} strokeWidth={1.5} /></div><h3>I’m here. Where shall we start?</h3><p>A big idea, a small question, or just a moment<br className="desktop-break" /> to untangle your thoughts.</p><span className="welcome-caption">YOUR SPACE TO BE YOURSELF</span></div> : <>
        {messages.map(message => <div key={message.id} className={`message message-${message.role}`}><span className={`message-avatar ${message.role === 'assistant' ? 'assistant-avatar' : ''}`}>{message.role === 'assistant' ? <Sparkles size={15} /> : (state.profile.name?.[0] || 'Y').toUpperCase()}</span><div className="message-body"><span className="message-author">{message.role === 'assistant' ? 'JARVIS' : 'You'}</span><p>{message.content}</p></div></div>)}
        {busy && <><div className="message message-user"><span className="message-avatar">{(state.profile.name?.[0] || 'Y').toUpperCase()}</span><div className="message-body"><span className="message-author">You</span><p>{pendingMessage}</p></div></div><div className="message message-assistant"><span className="message-avatar assistant-avatar"><Sparkles size={15} /></span><div className="message-body"><span className="message-author">JARVIS</span><span className="thinking"><span /><span /><span /><small>Thinking with you…</small></span></div></div></>}
      </>}
      <div ref={messageEnd} />
    </div>
    <form className="composer" onSubmit={sendMessage}><label className="sr-only" htmlFor={`message-${compact ? 'overview' : 'full'}`}>Message JARVIS</label><textarea id={`message-${compact ? 'overview' : 'full'}`} ref={composerRef} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendMessage(event) } }} placeholder={networkAvailable ? 'What’s on your mind?' : 'Reconnect to start a conversation'} rows={2} disabled={!networkAvailable || busy} data-testid="message-input" /><div className="composer-bottom"><span><span className="composer-status" />{listening ? 'Listening… speak naturally' : 'A little clarity starts here'}</span><div><button className={`icon-button mic-button ${listening ? 'listening' : ''}`} type="button" onClick={toggleVoice} disabled={!networkAvailable || busy} aria-label={listening ? 'Stop dictation' : voiceSupported ? 'Dictate a message' : 'Check voice availability'} title={voiceSupported ? 'Dictate a message' : 'Voice is unavailable in this browser'}>{listening ? <MicOff size={18} /> : <Mic size={18} />}</button><button className="send-button" type="submit" disabled={!input.trim() || busy || !networkAvailable} aria-label="Send message" data-testid="send-message">{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={19} />}</button></div></div></form>
    {voiceError && <p className="inline-error" role="alert"><AlertCircle size={14} />{voiceError}</p>}
    <p className="chat-footnote">JARVIS can make mistakes. Use your judgment for important decisions.{voiceSupported && ' Browser dictation may use an online service.'}</p>
  </section>
}

function MemoryCard({ notes, mutate, disabled, compact, onExpand }) {
  const [adding, setAdding] = useState(!compact)
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(null)
  const [editContent, setEditContent] = useState('')
  async function add(event) {
    event.preventDefault()
    if (!content.trim()) return
    setSaving(true)
    const result = await mutate('/notes', 'POST', { content: content.trim() }, 'Memory saved.')
    if (result) { setContent(''); if (compact) setAdding(false) }
    setSaving(false)
  }
  async function saveEdit(event, note) {
    event.preventDefault()
    if (!editContent.trim()) return
    setSaving(true)
    const result = await mutate(`/notes/${encodeURIComponent(note.id)}`, 'PATCH', { content: editContent.trim() }, 'Memory updated.')
    if (result) setEditing(null)
    setSaving(false)
  }
  const displayed = compact ? notes.slice(-2).reverse() : [...notes].reverse()
  return <section className={`card memory-card ${compact ? 'compact-card' : ''}`}>
    <div className="card-heading"><div className="card-title"><span className="card-icon violet"><Brain size={17} /></span><h2>{compact ? 'On my mind' : 'Your memory'}{!compact && <span className="count">{notes.length}</span>}</h2></div>{compact ? <button className="icon-button" onClick={onExpand} aria-label="Open memory"><ArrowUpRight size={17} /></button> : null}</div>
    {!displayed.length && <div className={compact ? 'mini-empty' : ''}>{compact ? <><p>The good ideas. The little details.</p><span>Save something you’d like me to remember.</span></> : <Empty icon={Brain} title="Make room for a memory." description="A goal you’re working toward, how you like your coffee, or an idea you don’t want to lose." />}</div>}
    {displayed.length > 0 && <div className="notes-list">{displayed.map(note => <article className="note" key={note.id}>{editing === note.id ? <form onSubmit={event => saveEdit(event, note)}><label className="sr-only" htmlFor={`edit-${note.id}`}>Edit memory</label><textarea id={`edit-${note.id}`} value={editContent} onChange={event => setEditContent(event.target.value)} required maxLength={6000} /><div className="form-actions"><button className="button button-subtle" type="button" onClick={() => setEditing(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || disabled || !editContent.trim()}>Save memory</button></div></form> : <><span className="note-marker" /><div className="note-content"><p>{note.content}</p>{!compact && <span className="note-date">Saved {new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>}</div><div className="note-actions">{!compact && <button className="text-button" disabled={disabled} onClick={() => { setEditing(note.id); setEditContent(note.content) }}>Edit</button>}<button className="icon-button" disabled={disabled} aria-label={`Delete memory: ${note.content.slice(0, 40)}`} onClick={() => mutate(`/notes/${encodeURIComponent(note.id)}`, 'DELETE', undefined, 'Memory removed.')}><Trash2 size={14} /></button></div></>}</article>)}</div>}
    {adding ? <form className="add-memory-form" onSubmit={add}><label className="sr-only" htmlFor={`new-memory-${compact ? 'compact' : 'full'}`}>New memory</label><textarea id={`new-memory-${compact ? 'compact' : 'full'}`} placeholder="Something worth remembering…" value={content} onChange={event => setContent(event.target.value)} disabled={disabled || saving} required rows={compact ? 2 : 3} maxLength={6000} data-testid="memory-input" /><div className="form-actions">{compact && <button className="button button-subtle" type="button" onClick={() => setAdding(false)}>Cancel</button>}<button className="button button-primary" type="submit" disabled={disabled || saving || !content.trim()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Save memory</button></div></form> : <button className="add-row" onClick={() => setAdding(true)} disabled={disabled}><Plus size={15} /> Add a memory</button>}
  </section>
}

function TasksCard({ tasks, mutate, disabled, compact, onExpand }) {
  const [adding, setAdding] = useState(!compact)
  const [title, setTitle] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [saving, setSaving] = useState(false)
  const active = tasks.filter(task => !task.completed)
  const complete = tasks.filter(task => task.completed)
  const shown = compact ? active.slice(0, 3) : [...active, ...complete]
  async function add(event) {
    event.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    const result = await mutate('/tasks', 'POST', { title: title.trim(), dueAt: dueAt ? new Date(dueAt).toISOString() : null }, 'Task added.')
    if (result) { setTitle(''); setDueAt(''); if (compact) setAdding(false) }
    setSaving(false)
  }
  return <section className={`card tasks-card ${compact ? 'compact-card' : ''}`}>
    <div className="card-heading"><div className="card-title"><span className="card-icon amber"><ListTodo size={17} /></span><h2>{compact ? 'A little focus' : 'Your tasks'}</h2>{active.length > 0 && <span className="count">{active.length}</span>}</div>{compact && <button className="icon-button" onClick={onExpand} aria-label="Open tasks"><ArrowUpRight size={17} /></button>}</div>
    {shown.length ? <div className="tasks-list">{shown.map(task => <div key={task.id} className={`task ${task.completed ? 'task-complete' : ''}`}><button className="task-checkbox" disabled={disabled} role="checkbox" aria-checked={task.completed} aria-label={`Mark ${task.title} ${task.completed ? 'incomplete' : 'complete'}`} onClick={() => mutate(`/tasks/${encodeURIComponent(task.id)}`, 'PATCH', { completed: !task.completed })}>{task.completed && <Check size={13} />}</button><div className="task-content"><p>{task.title}</p>{task.dueAt && <span className={`task-due ${!task.completed && new Date(task.dueAt) < new Date() ? 'overdue' : ''}`}><Clock3 size={11} />{new Date(task.dueAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>}</div><button className="icon-button task-delete" disabled={disabled} aria-label={`Delete task: ${task.title}`} onClick={() => mutate(`/tasks/${encodeURIComponent(task.id)}`, 'DELETE', undefined, 'Task removed.')}><Trash2 size={14} /></button></div>)}</div> : compact ? <div className="mini-empty"><p>A clear mind starts with a small step.</p><span>What’s one thing you’d like to get done?</span></div> : <Empty icon={ListTodo} title="Your next step starts here." description="Add something you want to do. You can set a time for a reminder, too." />}
    {adding ? <form className="add-task-form" onSubmit={add}><label className="sr-only" htmlFor={`new-task-${compact ? 'compact' : 'full'}`}>New task</label><input id={`new-task-${compact ? 'compact' : 'full'}`} placeholder="What’s your next step?" value={title} onChange={event => setTitle(event.target.value)} disabled={disabled || saving} required maxLength={300} data-testid="task-input" /><div className="task-form-bottom"><label><Clock3 size={14} /><span className="sr-only">Optional reminder time</span><input type="datetime-local" value={dueAt} onChange={event => setDueAt(event.target.value)} disabled={disabled || saving} title="Optional reminder time" /></label><div className="form-actions">{compact && <button className="icon-button" type="button" aria-label="Cancel task" onClick={() => setAdding(false)}><X size={15} /></button>}<button className="button button-primary" type="submit" disabled={disabled || saving || !title.trim()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Add task</button></div></div></form> : <button className="add-row" disabled={disabled} onClick={() => setAdding(true)}><Plus size={15} /> Add a task</button>}
  </section>
}

function ReminderSettings({ onToast }) {
  const [permission, setPermission] = useState(() => 'Notification' in window ? Notification.permission : 'unsupported')
  async function enable() {
    if (!window.isSecureContext) { onToast('Browser notifications require HTTPS or a connection on this device.'); return }
    try {
      const result = await Notification.requestPermission()
      setPermission(result)
      if (result === 'granted') onToast('Reminders are enabled while JARVIS is open.')
    } catch { onToast('This browser could not enable notifications. Your task times are still saved.') }
  }
  return <div className="reminder-settings"><span className="setting-icon"><Bell size={21} /></span><div><h3>A nudge, when you need it.</h3><p>Reminders work while this app is open and connected to your companion server. Keep JARVIS open for scheduled notifications.</p>{permission === 'denied' && <p className="muted-warning">Notifications are blocked. You can allow them in your browser’s site settings.</p>}{permission === 'unsupported' && <p className="muted-warning">This browser does not support notifications. You can still keep tasks and due times here.</p>}</div>{permission !== 'unsupported' && <button className={`button ${permission === 'granted' ? 'button-subtle' : 'button-primary'}`} onClick={enable} disabled={permission === 'granted' || permission === 'denied'}>{permission === 'granted' ? <><Check size={15} /> Enabled</> : 'Enable reminders'}</button>}</div>
}

function Settings({ state, status, mutate, disabled, refresh, loading, speaking, setSpeaking, install, onToast }) {
  const [profile, setProfile] = useState(state.profile)
  const [model, setModel] = useState(state.settings?.model || MODEL)
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '')
  const [saving, setSaving] = useState('')
  useEffect(() => setProfile(state.profile), [state.profile.name, state.profile.aboutMe, state.profile.preferences])
  useEffect(() => setModel(state.settings?.model || MODEL), [state.settings?.model])
  async function saveProfile(event) {
    event.preventDefault(); setSaving('profile')
    await mutate('/profile', 'PATCH', profile, 'Your profile is saved.')
    setSaving('')
  }
  async function saveModel(event) {
    event.preventDefault(); setSaving('model')
    const result = await mutate('/settings', 'PATCH', { model: model.trim() }, 'Model preference saved.')
    if (result) await refresh()
    setSaving('')
  }
  const models = [...new Set([state.settings?.model || MODEL, ...(status?.models || []), 'qwen2.5:1.5b', 'llama3.2:3b'])]
  return <div className="settings-grid"><div className="settings-primary">
    <section className="card settings-card"><div className="card-heading"><div className="card-title"><span className="card-icon"><Brain size={17} /></span><h2>A little about you</h2></div></div><p className="settings-description">Help JARVIS understand your world and the way you like to be helped.</p><form onSubmit={saveProfile} className="settings-form"><label>Your name<input value={profile.name || ''} onChange={event => setProfile({ ...profile, name: event.target.value })} placeholder="What should I call you?" disabled={disabled} maxLength={100} data-testid="profile-name" /></label><label>About you<textarea value={profile.aboutMe || ''} onChange={event => setProfile({ ...profile, aboutMe: event.target.value })} placeholder="Your goals, interests, work, or whatever you’d like me to know." rows={4} disabled={disabled} maxLength={3000} /></label><label>How you like to be helped<textarea value={profile.preferences || ''} onChange={event => setProfile({ ...profile, preferences: event.target.value })} placeholder="For example: Keep replies concise. Ask questions before giving advice. Be honest with me." rows={3} disabled={disabled} maxLength={3000} /></label><div className="form-actions"><button className="button button-primary" type="submit" disabled={disabled || saving === 'profile'}>{saving === 'profile' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Save profile</button></div></form></section>
    <section className="card settings-card"><div className="card-heading"><div className="card-title"><span className="card-icon"><Volume2 size={17} /></span><h2>Voice & presence</h2></div></div><div className="setting-row"><div><strong>Spoken replies</strong><p>Let your browser read JARVIS’s responses aloud.</p></div><button className={`toggle ${speaking ? 'toggle-on' : ''}`} role="switch" aria-checked={speaking} aria-label="Spoken replies" disabled={!(window.JarvisAndroid?.speak || 'speechSynthesis' in window)} onClick={() => setSpeaking(!speaking)}><span /></button></div><p className="settings-description">Tap the microphone in a conversation to dictate a message. Dictation depends on your browser and may use an online speech service. There is no background listening.</p><div className="setting-row install-setting"><div><strong>Keep your companion close</strong><p>Install JARVIS on your phone or computer from your browser.</p></div><button className="button button-subtle" onClick={install}><Download size={15} /> Install app</button></div></section>
  </div><div className="settings-secondary">
    <section className="card settings-card"><div className="card-heading"><div className="card-title"><span className="card-icon"><Cpu size={17} /></span><h2>Your local AI</h2></div><button className="icon-button" aria-label="Refresh model connection" onClick={refresh} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} /></button></div><div className={`model-status ${status?.online && status?.modelAvailable ? 'model-ready' : ''}`}><span className="status-dot" /><strong>{status?.online && status?.modelAvailable ? 'Connected and ready' : status?.online ? 'Model not installed' : 'Ollama is not connected'}</strong></div><p className="settings-description">Free conversation runs on your own computer using Ollama. The server must be able to reach it.</p>{(!status?.online || !status?.modelAvailable) && <div className="model-help"><p>Install and start <a href="https://ollama.com/download" target="_blank" rel="noreferrer">Ollama <ArrowUpRight size={12} /></a>, then download your model:</p><code>ollama pull {state.settings?.model || MODEL}</code><p>Keep Ollama running and refresh the connection. On another device, your companion computer still needs to be online.</p></div>}<form onSubmit={saveModel} className="settings-form"><label>Conversation model<input list="models" value={model} onChange={event => setModel(event.target.value)} disabled={disabled} required placeholder={MODEL} maxLength={120} /><datalist id="models">{models.map(item => <option key={item} value={item} />)}</datalist></label><small className="field-hint">qwen2.5:1.5b is a lightweight starting point. Larger models need more memory.</small><button className="button button-subtle" type="submit" disabled={disabled || saving === 'model' || !model.trim()}>{saving === 'model' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Save model</button></form></section>
    <section className="card settings-card"><div className="card-heading"><div className="card-title"><span className="card-icon"><LockKeyhole size={17} /></span><h2>Server access</h2></div></div><p className="settings-description">If your server requires an access token, save it here. It stays in this browser and is sent only to your companion server.</p><form className="settings-form" onSubmit={async event => { event.preventDefault(); if (token.trim()) localStorage.setItem(TOKEN_KEY, token.trim()); else localStorage.removeItem(TOKEN_KEY); await refresh(); onToast('Browser access token updated.') }}><label>Access token<input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Not required for local use" autoComplete="off" /></label><button className="button button-subtle" type="submit"><Check size={15} /> Save & reconnect</button></form></section>
    {window.JarvisDesktop && <DesktopConnection onToast={onToast} refresh={refresh} />}
    <div className="privacy-card settings-privacy"><ShieldCheck size={21} /><div><h3>A companion you control.</h3><p>Profile, memories, tasks, and conversation history are stored on your server. Conversation requests are processed by your configured Ollama model. No paid AI API is required.</p></div></div>
  </div></div>
}

function DesktopConnection({ onToast, refresh }) {
  const [downloading, setDownloading] = useState(false)
  useEffect(() => {
    const handler = event => {
      setDownloading(false)
      onToast(event.detail?.message || 'Model download finished.')
      refresh()
    }
    window.addEventListener('jarvis-model-download', handler)
    window.JarvisDesktop.getConnectionInfo().then(info => setDownloading(info.downloading)).catch(() => {})
    return () => window.removeEventListener('jarvis-model-download', handler)
  }, [onToast, refresh])
  async function download() {
    try {
      const result = await window.JarvisDesktop.downloadModel()
      setDownloading(Boolean(result.running))
      onToast(result.error || result.message)
    } catch { onToast('The download could not start. Install Ollama and try again.') }
  }
  return <section className="card settings-card">
    <div className="card-heading"><div className="card-title"><span className="card-icon"><Download size={17} /></span><h2>Desktop & Android</h2></div></div>
    <p className="settings-description">Install Ollama once, then download the free AI model here. No Node.js or npm setup is needed for this desktop app.</p>
    <div className="desktop-actions">
      <button className="button button-subtle" onClick={() => window.JarvisDesktop.installOllama()}>Install Ollama</button>
      <button className="button button-primary" disabled={downloading} onClick={download}>{downloading ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{downloading ? 'Downloading model…' : 'Download free AI'}</button>
      <button className="button button-subtle" onClick={() => window.JarvisDesktop.showPhoneHelp()}>Connect Android phone</button>
      <button className="button button-subtle" onClick={async () => { await window.JarvisDesktop.copyPhoneKey(); onToast('Phone key copied. Enter it on your Android app’s unlock screen.') }}><LockKeyhole size={15} /> Copy phone key</button>
    </div>
    <p className="settings-description">Keep JARVIS open on this computer for phone access. Your phone connects through your private HTTPS address and uses this PC’s AI.</p>
  </section>
}

export default App
