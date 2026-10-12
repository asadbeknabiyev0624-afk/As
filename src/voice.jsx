import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, LoaderCircle, Mic, MicOff, Volume2 } from 'lucide-react'
import { analyseRecording, concatAudioChunks, encodeMonoWav, resampleMono } from './voice-audio.mjs'
import './voice.css'

const MAX_RECORDING_SECONDS = 30
const LANGUAGE_KEY = 'jarvis-mic-language'
const LANGUAGES = [{ value: 'en', label: 'English (UK)' }, { value: 'uz', label: 'Uzbek' }, { value: 'ru', label: 'Russian' }]
const INITIAL_STATUS = { phase: 'idle', status: 'Download your British voice and microphone model to get started.', progress: null, error: null }
const desktopBridge = () => typeof window === 'undefined' ? null : window.JarvisDesktop
const audioContextConstructor = () => typeof window === 'undefined' ? null : window.AudioContext || window.webkitAudioContext

function readLanguage() {
  try {
    const language = localStorage.getItem(LANGUAGE_KEY)
    return LANGUAGES.some(item => item.value === language) ? language : 'en'
  } catch { return 'en' }
}

function releaseRecording(recording) {
  if (!recording) return
  clearTimeout(recording.timeout)
  clearInterval(recording.countdown)
  if (recording.processor) recording.processor.onaudioprocess = null
  for (const node of [recording.source, recording.processor, recording.gain]) {
    try { node?.disconnect() } catch { /* The node may already be disconnected. */ }
  }
  recording.stream?.getTracks().forEach(track => track.stop())
  if (recording.context && recording.context.state !== 'closed') recording.context.close().catch(() => {})
}

function microphoneError(error) {
  const messages = {
    NotAllowedError: 'Microphone access was denied. In Windows Settings → Privacy & security → Microphone, turn on Microphone access and Allow desktop apps to access your microphone, then try again.',
    PermissionDeniedError: 'In Windows microphone privacy settings, turn on Allow desktop apps to access your microphone, then try again.',
    NotFoundError: 'No microphone was found. Connect a microphone and select it in Windows sound settings.',
    DevicesNotFoundError: 'No microphone was found. Connect one and try again.',
    NotReadableError: 'The microphone could not be opened. Check Windows sound settings and close another app if it is using the microphone exclusively.',
    TrackStartError: 'The microphone could not be opened. Check your Windows input device.',
    SecurityError: 'Microphone access is blocked. Check the JARVIS app and Windows microphone permissions.',
  }
  return messages[error?.name] || error?.message || 'Microphone recording could not start. Check your input device and try again.'
}

function speechText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' A code example is shown in the conversation. ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/gi, 'the link shown in the conversation')
    .replace(/(?:\*\*|__|`)/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/gm, '')
    .trim()
}

/** Windows uses local Whisper/Piper IPC; Android/browser voice stays in App. */
export function useJarvisVoice({ onTranscript, onError } = {}) {
  const [voiceStatus, setVoiceStatus] = useState(INITIAL_STATUS)
  const [listening, setListening] = useState(false)
  const [requestingPermission, setRequestingPermission] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [preparingSpeech, setPreparingSpeech] = useState(false)
  const [remainingSeconds, setRemainingSeconds] = useState(MAX_RECORDING_SECONDS)
  const [error, setError] = useState('')
  const [language, setLanguageState] = useState(readLanguage)
  const mounted = useRef(true)
  const callbacks = useRef({ onTranscript, onError })
  callbacks.current = { onTranscript, onError }
  const statusRef = useRef(INITIAL_STATUS)
  const languageRef = useRef(language)
  const recorder = useRef(null)
  const requestingRef = useRef(false)
  const transcribingRef = useRef(false)
  const recordingGeneration = useRef(0)
  const transcriptionGeneration = useRef(0)
  const speechGeneration = useRef(0)
  const playback = useRef(null)
  const stopRef = useRef(null)
  const bridge = desktopBridge()
  const supported = Boolean(bridge?.transcribeVoice && bridge?.speakVoice && typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia && audioContextConstructor())

  const reportError = useCallback(message => {
    if (mounted.current) {
      setError(message)
      callbacks.current.onError?.(message)
    }
  }, [])

  const applyStatus = useCallback(snapshot => {
    if (!mounted.current || !snapshot || !['idle', 'downloading', 'ready', 'error'].includes(snapshot.phase)) return
    const next = {
      phase: snapshot.phase,
      status: typeof snapshot.status === 'string' ? snapshot.status : '',
      progress: typeof snapshot.progress === 'number' && Number.isFinite(snapshot.progress) ? Math.max(0, Math.min(100, snapshot.progress)) : null,
      error: typeof snapshot.error === 'string' ? snapshot.error : null,
    }
    statusRef.current = next
    setVoiceStatus(next)
  }, [])

  const stopSpeaking = useCallback(() => {
    speechGeneration.current++
    const current = playback.current
    playback.current = null
    if (current) {
      current.audio.onended = null
      current.audio.onerror = null
      current.audio.pause()
      current.audio.removeAttribute('src')
      current.audio.load()
      URL.revokeObjectURL(current.url)
    }
    if (mounted.current) {
      setSpeaking(false)
      setPreparingSpeech(false)
    }
  }, [])

  const cancelRecording = useCallback(() => {
    recordingGeneration.current++
    requestingRef.current = false
    const current = recorder.current
    recorder.current = null
    releaseRecording(current)
    if (mounted.current) {
      setListening(false)
      setRequestingPermission(false)
      setRemainingSeconds(MAX_RECORDING_SECONDS)
    }
  }, [])

  const stop = useCallback(async () => {
    const current = recorder.current
    cancelRecording()
    if (!current || !mounted.current) return
    const samples = concatAudioChunks(current.chunks)
    const analysis = analyseRecording(samples, current.sampleRate)
    if (!analysis.hasSpeech) {
      reportError(analysis.duration < 0.4 ? 'That recording was too short. Hold a short conversation phrase, then stop.' : 'I did not hear enough speech. Check the selected Windows microphone, move closer, and try again.')
      return
    }
    const native = desktopBridge()
    if (!native?.transcribeVoice) return reportError('Update the Windows app to use local microphone recognition.')
    const generation = ++transcriptionGeneration.current
    transcribingRef.current = true
    setTranscribing(true)
    try {
      const wav = encodeMonoWav(resampleMono(samples, current.sampleRate), 16000)
      const result = await native.transcribeVoice(wav, current.language)
      if (!mounted.current || generation !== transcriptionGeneration.current) return
      const text = typeof result?.text === 'string' ? result.text.trim() : ''
      if (!text || /^\[?(?:blank_audio|silence|music)\]?$/i.test(text)) {
        reportError('No words were recognised. Try a clearer phrase, or choose the language you are speaking.')
        return
      }
      // The parent fills the composer. It must not submit this transcript automatically.
      callbacks.current.onTranscript?.(text)
    } catch (error) {
      if (mounted.current && generation === transcriptionGeneration.current) reportError(error?.message || 'Local speech recognition could not finish. Check voice setup and try again.')
    } finally {
      if (generation === transcriptionGeneration.current) {
        transcribingRef.current = false
        if (mounted.current) setTranscribing(false)
      }
    }
  }, [cancelRecording, reportError])
  stopRef.current = stop

  const start = useCallback(async () => {
    if (recorder.current || requestingRef.current) return
    if (mounted.current) setError('')
    if (!supported) return reportError('Local microphone recognition is available in the updated Windows app. You can still type your message.')
    if (transcribingRef.current) return reportError('Please wait while I finish recognising the last recording.')
    if (statusRef.current.phase !== 'ready') return reportError('Download the British voice and microphone model in Settings before recording.')
    stopSpeaking()
    const generation = ++recordingGeneration.current
    requestingRef.current = true
    setRequestingPermission(true)
    let current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      current = { stream, chunks: [], sampleCount: 0, language: languageRef.current }
      if (!mounted.current || generation !== recordingGeneration.current) return releaseRecording(current)
      const AudioContextClass = audioContextConstructor()
      current.context = new AudioContextClass()
      current.sampleRate = current.context.sampleRate
      if (current.context.state === 'suspended') await current.context.resume()
      if (!mounted.current || generation !== recordingGeneration.current) return releaseRecording(current)
      current.source = current.context.createMediaStreamSource(stream)
      current.processor = current.context.createScriptProcessor(2048, 1, 1)
      current.gain = current.context.createGain()
      current.gain.gain.value = 0
      const sampleLimit = Math.floor(current.sampleRate * MAX_RECORDING_SECONDS)
      current.processor.onaudioprocess = event => {
        event.outputBuffer.getChannelData(0).fill(0)
        if (recorder.current !== current) return
        const input = event.inputBuffer.getChannelData(0)
        const available = Math.min(input.length, sampleLimit - current.sampleCount)
        if (available > 0) {
          current.chunks.push(new Float32Array(input.subarray(0, available)))
          current.sampleCount += available
        }
        if (current.sampleCount >= sampleLimit) void stopRef.current?.()
      }
      current.source.connect(current.processor)
      current.processor.connect(current.gain)
      current.gain.connect(current.context.destination)
      recorder.current = current
      const startedAt = performance.now()
      current.countdown = setInterval(() => {
        if (mounted.current && recorder.current === current) setRemainingSeconds(Math.max(0, Math.ceil(MAX_RECORDING_SECONDS - (performance.now() - startedAt) / 1000)))
      }, 200)
      current.timeout = setTimeout(() => void stopRef.current?.(), MAX_RECORDING_SECONDS * 1000)
      setRemainingSeconds(MAX_RECORDING_SECONDS)
      setListening(true)
    } catch (error) {
      releaseRecording(current)
      if (generation === recordingGeneration.current) reportError(microphoneError(error))
    } finally {
      if (generation === recordingGeneration.current) {
        requestingRef.current = false
        if (mounted.current) setRequestingPermission(false)
      }
    }
  }, [reportError, stopSpeaking, supported])

  const toggle = useCallback(() => {
    if (recorder.current || requestingRef.current) return stop()
    return start()
  }, [start, stop])

  const speak = useCallback(async text => {
    const content = speechText(text)
    if (!content) return
    if (mounted.current) setError('')
    const native = desktopBridge()
    if (!native?.speakVoice) return reportError('The British voice is available in the updated Windows app.')
    if (statusRef.current.phase !== 'ready') return reportError('Download the British voice in Settings before testing spoken replies.')
    cancelRecording()
    stopSpeaking()
    const generation = speechGeneration.current
    setPreparingSpeech(true)
    try {
      const result = await native.speakVoice(content)
      const data = result?.audio ?? result
      if (!mounted.current || generation !== speechGeneration.current) return
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('The voice helper did not return WAV audio. Try voice setup again.')
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      if (bytes.length < 44 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE') throw new Error('The voice helper returned invalid WAV audio. Try voice setup again.')
      // The WAV header supplies Piper's actual sample rate; do not relabel raw PCM.
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
      const audio = new Audio(url)
      playback.current = { audio, url }
      const finished = () => {
        if (playback.current?.audio !== audio) return
        playback.current = null
        URL.revokeObjectURL(url)
        if (mounted.current) { setSpeaking(false); setPreparingSpeech(false) }
      }
      audio.onended = finished
      audio.onerror = () => { finished(); reportError('The British voice audio could not play. Check your Windows sound output, then try again.') }
      await audio.play()
      if (!mounted.current || generation !== speechGeneration.current) return
      setPreparingSpeech(false)
      setSpeaking(true)
    } catch (error) {
      if (generation !== speechGeneration.current) return
      stopSpeaking()
      reportError(error?.name === 'NotAllowedError' ? 'Click Test British voice to allow audio playback, then try again.' : error?.message || 'The British voice could not finish. Check voice setup and try again.')
    }
  }, [cancelRecording, reportError, stopSpeaking])

  const setupVoice = useCallback(async () => {
    const native = desktopBridge()
    if (!native?.setupVoice || !native?.getVoiceStatus) return reportError('Update the Windows app to install its local voice models.')
    if (statusRef.current.phase === 'downloading') return
    setError('')
    applyStatus({ phase: 'downloading', status: 'Preparing the voice and microphone download…', progress: null, error: null })
    try {
      const result = await native.setupVoice()
      if (result?.error) throw new Error(result.error)
      const snapshot = await native.getVoiceStatus()
      applyStatus(snapshot)
      if (result?.running && snapshot?.phase === 'idle') applyStatus({ phase: 'downloading', status: result.message || 'Downloading voice and microphone models…', progress: null, error: null })
    } catch (error) {
      applyStatus({ phase: 'error', status: 'Voice setup could not finish.', progress: null, error: error?.message || 'Check your connection and retry the voice download.' })
    }
  }, [applyStatus, reportError])

  const setLanguage = useCallback(value => {
    if (!LANGUAGES.some(item => item.value === value)) return
    languageRef.current = value
    setLanguageState(value)
    try { localStorage.setItem(LANGUAGE_KEY, value) } catch { /* The choice still applies in this session. */ }
  }, [])

  useEffect(() => {
    mounted.current = true
    const native = desktopBridge()
    let canceled = false
    const receive = snapshot => { if (!canceled) applyStatus(snapshot) }
    const unsubscribe = native?.onVoiceStatus?.(receive)
    native?.getVoiceStatus?.().then(receive).catch(error => {
      if (!canceled) applyStatus({ phase: 'error', status: 'Could not check voice setup.', progress: null, error: error?.message || 'Restart the app and try again.' })
    })
    return () => {
      canceled = true
      mounted.current = false
      if (typeof unsubscribe === 'function') unsubscribe()
      transcriptionGeneration.current++
      transcribingRef.current = false
      cancelRecording()
      stopSpeaking()
    }
  }, [applyStatus, cancelRecording, stopSpeaking])

  return { supported, listening, requestingPermission, transcribing, speaking, preparingSpeech, voiceStatus, error, remainingSeconds, language, speakerLanguage: 'en-GB', setLanguage, start, stop, toggle, speak, stopSpeaking, cancelRecording, setupVoice }
}

export function VoiceSettings({ voice }) {
  if (!desktopBridge() || !voice) return null
  const { voiceStatus, listening, transcribing, speaking, preparingSpeech, requestingPermission } = voice
  const downloading = voiceStatus.phase === 'downloading'
  const ready = voiceStatus.phase === 'ready'
  const compatible = Boolean(desktopBridge()?.setupVoice && desktopBridge()?.transcribeVoice && desktopBridge()?.speakVoice)
  return <section className="card settings-card jarvis-native-voice" aria-labelledby="jarvis-voice-heading">
    <div className="card-heading"><div className="card-title"><span className="card-icon"><Volume2 size={17} /></span><h2 id="jarvis-voice-heading">British voice & microphone</h2></div><span className="label-pill">Local voice</span></div>
    <p className="settings-description">Clear English (UK) speech with a local British voice. Download the voice and microphone models once, about 235 MB. Recording and playback then work on your computer.</p>
    <div className={`jarvis-voice-status jarvis-voice-status-${voiceStatus.phase}`} role="status" aria-live="polite">
      <strong>{ready ? 'British voice is ready' : downloading ? 'Setting up your voice' : voiceStatus.phase === 'error' ? 'Voice setup needs attention' : 'Set up your voice'}</strong>
      <p>{compatible ? voiceStatus.status || (ready ? 'Your microphone and British voice are ready.' : 'Download the models to enable local voice.') : 'Update the Windows app to get the local British voice and microphone helper.'}</p>
      {downloading && <div className="jarvis-voice-download-progress">{voiceStatus.progress === null ? <><LoaderCircle size={16} className="jarvis-voice-spin" /><span>Preparing or downloading…</span></> : <><progress max="100" value={voiceStatus.progress} aria-label="Voice model download progress" /><span>{Math.round(voiceStatus.progress)}%</span></>}</div>}
      {voiceStatus.error && <p className="jarvis-voice-error" role="alert">{voiceStatus.error}</p>}
      {voiceStatus.error?.includes('Visual C++') && <a className="button button-subtle" href="https://aka.ms/vs/17/release/vc_redist.x64.exe" target="_blank" rel="noreferrer">Install Microsoft runtime</a>}
    </div>
    <div className="jarvis-voice-actions">
      {!ready && <button className="button button-subtle" onClick={voice.setupVoice} disabled={!compatible || downloading}>{downloading ? <LoaderCircle size={16} className="jarvis-voice-spin" /> : <Download size={16} />}{downloading ? 'Downloading voice…' : voiceStatus.phase === 'error' ? 'Retry voice download' : 'Download voice & microphone'}</button>}
      <button className="button button-subtle" disabled={!ready || !compatible || transcribing || listening || requestingPermission} onClick={() => speaking || preparingSpeech ? voice.stopSpeaking() : voice.speak('Good evening. I am JARVIS, your personal assistant. The British voice is ready. How may I help you today?')}>{preparingSpeech ? <LoaderCircle size={16} className="jarvis-voice-spin" /> : <Volume2 size={16} />}{speaking || preparingSpeech ? 'Stop voice test' : 'Test British voice'}</button>
    </div>
    <div className="setting-row jarvis-voice-language"><div><label htmlFor="jarvis-mic-language"><strong>Microphone language</strong></label><p>Choose the language you will speak. JARVIS’s voice uses English (UK).</p></div><select id="jarvis-mic-language" value={voice.language} onChange={event => voice.setLanguage(event.target.value)} disabled={listening || transcribing || requestingPermission}>{LANGUAGES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
    <div className="jarvis-voice-microphone-test"><button className="button button-subtle" disabled={!ready || !voice.supported || transcribing} onClick={voice.toggle}>{transcribing || requestingPermission ? <LoaderCircle size={16} className="jarvis-voice-spin" /> : listening ? <MicOff size={16} /> : <Mic size={16} />}{transcribing ? 'Recognising speech…' : requestingPermission ? 'Cancel microphone request' : listening ? 'Stop & review words' : 'Test microphone'}</button><span role="status">{listening ? `Listening · ${voice.remainingSeconds}s remaining` : transcribing ? 'Converting your recording into text.' : 'Your words appear in the message box for review before sending.'}</span></div>
    {voice.error && <p className="jarvis-voice-error" role="alert">{voice.error}</p>}
    <p className="settings-description jarvis-voice-footnote">Recording stops after 30 seconds. Allow microphone access in Windows privacy settings if asked. Nothing listens in the background.</p>
  </section>
}
