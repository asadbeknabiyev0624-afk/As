import { useId } from 'react'
import { ArrowUpRight, AudioLines, Cpu, ShieldCheck } from 'lucide-react'

function polar(radius, degrees) {
  const radians = degrees * Math.PI / 180
  return [220 + radius * Math.cos(radians), 220 + radius * Math.sin(radians)]
}

function arc(radius, start, end) {
  const [x1, y1] = polar(radius, start)
  const [x2, y2] = polar(radius, end)
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${x2} ${y2}`
}

/** Decorative reactor. Only its activity reflects real listening/processing state. */
export function HudOrb({ small = false, listening = false, busy = false, speaking = false, available = false }) {
  const uid = useId().replace(/:/g, '')
  const glowId = `hud-glow-${uid}`
  const coreId = `hud-core-${uid}`
  const fieldId = `hud-field-${uid}`
  return <div className={`hud-reactor ${small ? 'hud-reactor-small' : ''} ${listening ? 'hud-reactor-listening' : ''} ${busy ? 'hud-reactor-busy' : ''} ${speaking ? 'hud-reactor-speaking' : ''} ${available ? 'hud-reactor-online' : ''}`} aria-hidden="true">
    <div className="hud-reactor-aura" />
    <svg viewBox="0 0 440 440" className="hud-reactor-svg" fill="none">
      <defs>
        <filter id={glowId} x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="3.2" /><feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <radialGradient id={coreId}><stop offset="0" stopColor="#bafaff" stopOpacity=".65" /><stop offset=".35" stopColor="#29bfd9" stopOpacity=".22" /><stop offset="1" stopColor="#071e28" stopOpacity=".2" /></radialGradient>
        <radialGradient id={fieldId}><stop offset="0" stopColor="#4bcbef" stopOpacity=".14" /><stop offset=".68" stopColor="#1595b3" stopOpacity=".025" /><stop offset="1" stopColor="#0a1824" stopOpacity="0" /></radialGradient>
      </defs>
      <circle cx="220" cy="220" r="214" fill={`url(#${fieldId})`} />
      <g className="hud-reactor-crosshair" stroke="#2f687b" strokeWidth=".75">
        <path d="M5 220H57M383 220H435M220 5V57M220 383V435" />
        <path d="M9 212V228M431 212V228M212 9H228M212 431H228" />
        <circle cx="220" cy="220" r="207" strokeOpacity=".35" />
        <circle cx="220" cy="220" r="185" strokeOpacity=".2" strokeDasharray="1 9" />
      </g>
      <g className="hud-reactor-ticks">{Array.from({ length: 120 }, (_, i) => {
        const major = i % 10 === 0
        const medium = i % 5 === 0
        const [x1, y1] = polar(major ? 189 : medium ? 195 : 198, i * 3)
        const [x2, y2] = polar(203, i * 3)
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={major ? '#86e3f2' : '#387b90'} strokeWidth={major ? 1.5 : 1} opacity={major ? .8 : .5} />
      })}</g>
      <g className="hud-reactor-outer-orbit" strokeLinecap="square">
        <path d={arc(175, -83, -25)} stroke="#7dd9e9" strokeWidth="4" />
        <path d={arc(175, -16, 47)} stroke="#284e62" strokeWidth="4" />
        <path d={arc(175, 57, 102)} stroke="#80dceb" strokeWidth="4" />
        <path d={arc(175, 112, 180)} stroke="#284e62" strokeWidth="4" />
        <path d={arc(175, 190, 231)} stroke="#e3b270" strokeWidth="4" />
        <path d={arc(175, 241, 265)} stroke="#284e62" strokeWidth="4" />
        <circle cx="220" cy="220" r="168" stroke="#4c93a9" strokeWidth=".8" strokeDasharray="100 14 5 14" opacity=".65" />
      </g>
      <g className="hud-reactor-mid-orbit">
        <circle cx="220" cy="220" r="155" stroke="#36677b" strokeWidth="1" />
        <circle cx="220" cy="220" r="150" stroke="#63ccdf" strokeWidth="1" strokeDasharray="1 5" opacity=".6" />
        {[0, 120, 240].map(angle => <g key={angle} transform={`rotate(${angle} 220 220)`}><path d={arc(143, -80, -22)} stroke="#65d8eb" strokeWidth="9" opacity=".85" /><path d={arc(133, -76, -27)} stroke="#aff3fc" strokeWidth="2" opacity=".9" /><path d="M237 76L243 81L248 75" stroke="#87e7f5" strokeWidth="1.5" /></g>)}
      </g>
      <g className="hud-reactor-inner-orbit" stroke="#3b8da5">
        <circle cx="220" cy="220" r="119" strokeWidth=".75" />
        <circle cx="220" cy="220" r="109" strokeWidth="1" strokeDasharray="23 5" />
        {Array.from({ length: 24 }, (_, i) => {
          const [x1, y1] = polar(101, i * 15)
          const [x2, y2] = polar(115, i * 15)
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth="1" opacity=".5" />
        })}
      </g>
      <circle cx="220" cy="220" r="97" fill={`url(#${coreId})`} stroke="#53afc5" strokeWidth="1" />
      <circle cx="220" cy="220" r="88" stroke="#83d7e8" strokeWidth=".75" strokeOpacity=".55" />
      <g className="hud-reactor-core" filter={`url(#${glowId})`}>
        <path d="M220 163L270 247H170Z" stroke="#b8f7ff" strokeWidth="2.5" fill="#69d8ef0a" strokeLinejoin="round" />
        <path d="M220 178L257 241H183Z" stroke="#54cde5" strokeWidth="1" fill="#5bd9ef0b" strokeLinejoin="round" />
        <path d="M220 196L243 235H197Z" fill="#b6f7ff" fillOpacity=".14" stroke="#9decf7" strokeWidth=".7" />
        <path d="M220 151V136M280 254L293 262M160 254L147 262" stroke="#b1f3ff" strokeWidth="2" />
      </g>
      {[0, 120, 240].map(angle => <g key={angle} transform={`rotate(${angle} 220 220)`}><path d="M214 128L220 119L226 128" stroke="#74d9eb" strokeWidth="1" fill="#53b4cb14" /><rect x="217" y="66" width="6" height="6" fill="#9ae9f6" transform="rotate(45 220 69)" /></g>)}
      <g stroke="#55a8c0" strokeWidth="1" opacity=".7"><path d="M63 157H43L34 148H5M377 279H397L406 288H435M85 353H43L34 362H5M355 87H397L406 78H435" /><circle cx="63" cy="157" r="2" fill="#81d6e7" /><circle cx="377" cy="279" r="2" fill="#81d6e7" /></g>
    </svg>
    <div className="hud-reactor-caption"><span />{listening ? 'VOICE INPUT ACTIVE' : speaking ? 'VOICE OUTPUT ACTIVE' : busy ? 'PROCESSING REQUEST' : available ? 'AI CORE ONLINE' : 'AI CORE STANDBY'}<span /></div>
  </div>
}

export function HudHero({ name = 'friend', available = false, serverConnected = false, listening = false, busy = false, speaking = false, model = '', memoryCount, taskCount, onStart }) {
  const stateLabel = listening ? 'LISTENING' : speaking ? 'SPEAKING' : busy ? 'PROCESSING' : available ? 'READY' : 'SETUP REQUIRED'
  return <section className="hud-hero" aria-label="JARVIS assistant status">
    <div className="hud-hero-copy">
      <div className="hud-protocol"><span className={available ? 'hud-protocol-dot online' : 'hud-protocol-dot'} /><span>J.A.R.V.I.S. / PERSONAL INTELLIGENCE</span><span className="hud-protocol-rule" /></div>
      <h1>At your service,<br /><span>{name}.</span></h1>
      <p>Your ideas. Your questions. Your next move.<br />Let’s turn them into something extraordinary.</p>
      <button className="hud-command-button" onClick={onStart}><span className="hud-button-bracket">[</span> OPEN COMMUNICATION <ArrowUpRight size={17} /><span className="hud-button-bracket">]</span></button>
      <div className="hud-system-checks"><span><ShieldCheck size={13} /> PERSONAL MEMORY</span><span><Cpu size={13} /> LOCAL INTELLIGENCE</span></div>
    </div>
    <div className="hud-hero-reactor"><div className="hud-reactor-title"><span>INTELLIGENCE CORE</span><span className="hud-small-bracket">⌜ ⌝</span></div><HudOrb available={available} listening={listening} busy={busy} /><div className="hud-reactor-subtitle"><AudioLines size={12} /><span>{listening ? 'MICROPHONE ACTIVE' : 'AWAITING YOUR COMMAND'}</span></div></div>
    <div className="hud-system-strip">
      <div><span className="hud-system-label">ASSISTANT STATUS</span><strong className={available ? 'hud-status-online' : 'hud-status-standby'}><span />{stateLabel}</strong></div>
      <div><span className="hud-system-label">AI CONNECTION</span><strong>{available ? model || 'LOCAL MODEL' : serverConnected ? 'MODEL SETUP NEEDED' : 'SERVER DISCONNECTED'}</strong></div>
      {typeof taskCount === 'number' && <div><span className="hud-system-label">ACTIVE OBJECTIVES</span><strong>{String(taskCount).padStart(2, '0')} <small>{taskCount === 1 ? 'TASK' : 'TASKS'}</small></strong></div>}
      {typeof memoryCount === 'number' && <div><span className="hud-system-label">MEMORY ARCHIVE</span><strong>{String(memoryCount).padStart(2, '0')} <small>{memoryCount === 1 ? 'ENTRY' : 'ENTRIES'}</small></strong></div>}
    </div>
  </section>
}
