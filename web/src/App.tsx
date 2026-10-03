import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react'
import { SafeBoundary } from './garden/SafeBoundary'
const Garden = lazy(() => import('./garden/Garden').then(module => ({ default: module.Garden })))
import { ask, startSession, stripWakeWord, type Answer } from './api'
import { useFeed } from './useFeed'
import { speechRecognition, type Recognition } from './voice'
import IrisVisual from './IrisVisual'
import { EventSpeech } from './eventSpeech'
import { AudioLevel } from './audioLevel'
import './figma-phone.css'

type Phase = 'idle' | 'listening' | 'thinking' | 'answering' | 'error'
function initialSession() {
  try { return localStorage.getItem('iris-session') || 'judge-01' } catch { return 'judge-01' }
}
export default function App() {
  const [session, setSession] = useState(initialSession)
  const [sessionOnline, setSessionOnline] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setSessionOnline(false)
    void startSession(session, controller.signal).then(ok => {
      if (!controller.signal.aborted) setSessionOnline(ok)
    })
    return () => controller.abort()
  }, [session])
  const [draft, setDraft] = useState(session)
  const [demo, setDemo] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const dashboard = location.pathname === '/dashboard'
  const garden = location.pathname === '/garden'
  function changeSession() {
    const next = draft.trim()
    if (!next) return
    setSession(next)
    try { localStorage.setItem('iris-session', next) } catch { /* Session still works without storage. */ }
  }
  const sessionControls = <div className="session-bar"><form onSubmit={e => { e.preventDefault(); changeSession() }}><label htmlFor="session">SESSION</label><input id="session" value={draft} maxLength={80} onChange={e => setDraft(e.target.value)} /><button disabled={!draft.trim() || draft.trim() === session}>Apply</button></form>
      <label className="demo-toggle"><input type="checkbox" checked={demo} onChange={e => setDemo(e.target.checked)} /> Demo mode</label>
    </div>
  return <div className={`app-shell ${!dashboard && !garden ? "phone-shell" : ""} ${garden ? "garden-route" : ""}`}>
    <header className="topbar"><a className="brand" href="/phone"><span className="identity-slot"><img src="/figma/identity.svg" alt="" /></span><span className="brand-copy"><strong>IRIS</strong><small>Your glasses, connected</small></span></a>
      <nav aria-label="Main navigation"><a className={!dashboard && !garden ? 'active' : ''} href="/phone">Companion</a><a className={dashboard ? 'active' : ''} href="/dashboard">Dashboard</a><a className={garden ? 'active' : ''} href={`/garden?session=${encodeURIComponent(session)}`}>Garden</a></nav>
      
    </header>
    {(dashboard) && sessionControls}
    {demo && (dashboard || garden) && <div className="demo-banner">DEMO MODE · Scripted examples, no camera or brain connection. Answers are not observations.</div>}
    {garden && <nav className="garden-navigation" aria-label="Garden navigation"><a href="/phone">← Companion</a><span>MEMORY GARDEN</span><a href="/dashboard">Dashboard →</a></nav>}
    {garden ? <SafeBoundary fallback={<main className="empty-page"><h1>The garden could not load.</h1><p>Try reloading, or return to the companion.</p><a href="/phone">Back to companion →</a></main>}><Suspense fallback={<main className="empty-page" role="status">Opening your memory garden…</main>}><Garden /></Suspense></SafeBoundary> :
      dashboard ? <Dashboard key={session + demo} session={session} demo={demo} sessionOnline={sessionOnline} /> : <Phone key={session + demo} session={session} demo={demo} sessionOnline={sessionOnline} menu={sessionControls} settingsOpen={settingsOpen} onSettings={() => setSettingsOpen(!settingsOpen)} />}
    <footer><span>Iris</span><span>MHacks 2026</span></footer>
  </div>
}
function Phone({ session, demo, sessionOnline, menu, settingsOpen, onSettings }: { session: string; demo: boolean; sessionOnline: boolean; menu: ReactNode; settingsOpen: boolean; onSettings: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [error, setError] = useState('')
  const [latency, setLatency] = useState<number | null>(null)
  const [wake, setWake] = useState('Requesting screen wake lock')
  const [voiceNote, setVoiceNote] = useState('')
  const [wakeWord, setWakeWord] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [audioLevel] = useState(() => new AudioLevel())
  const speaker = useRef<EventSpeech | null>(null)
  const { events, status: feedStatus } = useFeed(session, demo, event => speaker.current?.receive(event))
  const status = demo ? feedStatus : !sessionOnline ? 'Offline · session unavailable' : feedStatus
  useEffect(() => {
    const voice = new EventSpeech(audioLevel, setSpeaking, setVoiceNote)
    speaker.current = voice
    window.addEventListener('pointerdown', voice.unlock)
    window.addEventListener('keydown', voice.unlock)
    return () => {
      window.removeEventListener('pointerdown', voice.unlock)
      window.removeEventListener('keydown', voice.unlock)
      voice.dispose()
      speaker.current = null
    }
  }, [audioLevel])
  const recognition = useRef<Recognition | null>(null)
  const request = useRef<AbortController | null>(null)
  const micTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const demoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)
  const busy = phase === 'thinking' || phase === 'listening'
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false; recognition.current?.abort(); request.current?.abort(); audioLevel.dispose()
      clearTimeout(micTimer.current); clearTimeout(demoTimer.current)
    }
  }, [audioLevel])
  useEffect(() => {
    let disposed = false
    let lock: WakeLockSentinel | null = null
    async function acquire() {
      if (document.visibilityState !== 'visible') return
      if (!('wakeLock' in navigator)) { setWake('Keep your screen awake manually'); return }
      try {
        const next = await navigator.wakeLock.request('screen')
        if (disposed) { await next.release(); return }
        lock = next; setWake('Screen stays awake')
        next.addEventListener('release', () => { if (!disposed) setWake('Screen wake lock released') })
      } catch { if (!disposed) setWake('Keep your screen awake manually') }
    }
    void acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => { disposed = true; void lock?.release(); document.removeEventListener('visibilitychange', acquire) }
  }, [])
  function stopAudio() { speaker.current?.stop(); audioLevel.stop(); setSpeaking(false) }
  async function submit(text: string) {
    const clean = text.trim()
    if (!clean || request.current) return
    stopAudio(); setQuestion(clean); setError(''); setVoiceNote(''); setAnswer(null); setLatency(null); setPhase('thinking')
    const controller = new AbortController()
    request.current = controller
    const started = performance.now()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      let result: Answer
      if (demo) {
        await new Promise<void>(resolve => { demoTimer.current = setTimeout(resolve, 900); controller.signal.addEventListener('abort', () => { clearTimeout(demoTimer.current); resolve() }, { once: true }) })
        if (controller.signal.aborted) return
        result = { display: 'Demo: 12g protein per bar', speak: 'This is a scripted demo answer: twelve grams of protein per bar. Connect the brain to ask about what you are actually seeing.', level: 'speak', latency_ms: 900 }
      } else result = await ask(session, clean, controller.signal)
      if (!alive.current) return
      setAnswer(result); setLatency(Math.round(performance.now() - started)); setPhase('answering')
    } catch (err) {
      if (!alive.current) return
      setError(controller.signal.aborted ? 'The brain took too long. Check the connection and try again.' : err instanceof Error ? err.message : 'Could not reach the brain. Try again.')
      setPhase('error')
    } finally { clearTimeout(timeout); request.current = null }
  }
  function listen() {
    if (phase === 'listening') { recognition.current?.stop(); return }
    if (!window.isSecureContext) { setError('Microphone access needs HTTPS. Open your secure tunnel URL, or type below.'); setPhase('error'); return }
    const mic = speechRecognition()
    if (!mic) { setError('Speech recognition is unavailable in this browser. Type your question below.'); setPhase('error'); return }
    stopAudio(); setError(''); setVoiceNote(''); setQuestion(''); setPhase('listening')
    recognition.current = mic
    void audioLevel.startMic()
    mic.lang = 'en-US'; mic.continuous = false; mic.interimResults = true
    let finalText = ''
    let failed = false
    mic.onresult = event => {
      let text = ''
      for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript
      if (alive.current) setQuestion(text)
      finalText = text
    }
    mic.onerror = event => {
      failed = true
      audioLevel.stop()
      if (!alive.current) return
      setError(event.error === 'not-allowed' ? 'Microphone permission was denied. Allow it in browser settings, or type below.' : 'Could not hear you. Tap to try again or type your question.')
      setPhase('error')
    }
    mic.onend = () => {
      clearTimeout(micTimer.current); recognition.current = null; audioLevel.stop()
      if (!alive.current || failed) return
      const text = wakeWord ? stripWakeWord(finalText) : finalText.trim()
      if (!text) { setPhase('idle'); setVoiceNote(wakeWord ? 'Say “Iris” followed by your question. Tap to listen again.' : 'No question heard. Tap to try again.'); return }
      void submit(text)
    }
    try { mic.start(); micTimer.current = setTimeout(() => mic.stop(), 20000) }
    catch { audioLevel.stop(); recognition.current = null; setPhase('error'); setError('Microphone could not start. Try again or type below.') }
  }
  const streamed = events.find(e => e.type === 'answer_delta')
  const spoken = events.find(e => (e.type === 'answer' || e.type === 'decision' && e.level === 'speak') && e.speak?.trim())
  const nudge = events.find(e => e.type === 'decision' && e.level !== 'silent')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const sample = demo && !answer
  const protein = answer?.display.match(/(\d+(?:\.\d+)?)\s*g\s+protein/i)?.[1]
  const visualState = speaking ? 'speaking' : phase === 'listening' || phase === 'thinking' ? phase : 'idle'
  const stateLabel = speaking ? 'Speaking' : phase === 'thinking' ? 'Thinking' : phase === 'listening' ? 'Listening' : answer || sample ? 'Answered' : 'Ready'
  return <main className="figma-phone" data-node-id="3:417">
    <header className="figma-header">
      <div className="figma-identity"><span className="identity-slot"><img src="/figma/identity.svg" alt="" /></span><div><strong>IRIS</strong><p>Your glasses, connected</p></div></div>
      <button className="figma-more" aria-label="More options" aria-expanded={settingsOpen} onClick={onSettings}><img src="/figma/more.svg" alt="" /></button>
    </header>
    <div className="figma-question-row"><div className="figma-question"><p>{question || (demo ? 'How much protein is in this?' : 'What’s in front of you?')}</p><img src="/figma/scan.svg" alt="" /></div></div>
    <section className="figma-analysis" aria-label="Iris activity">
      <div className="figma-analysis-header"><span><span className="live-slot"><img src="/figma/live.svg" alt="" /></span>{stateLabel}</span><span>{demo ? 'DEMO' : status === 'Connected' ? 'LIVE' : 'OFFLINE'}</span></div>
      <IrisVisual state={visualState} readAmplitude={audioLevel.read} />
      
    </section>
    <h1 className="sr-only" aria-live="polite">{phase === 'answering' ? 'Here’s what I found.' : phase === 'thinking' ? 'Taking a closer look.' : phase === 'listening' ? 'I’m listening.' : 'Iris visual assistant'}</h1>
    <section className={'figma-answer ' + (!(protein || sample) ? 'general-answer' : '')} aria-label="Answer" aria-live="polite">
      {(protein || sample) && <div className="figma-amount"><strong>{protein || '12'} g</strong><span>PROTEIN</span></div>}
      <div className="figma-answer-copy"><p>{sample ? 'About 24% of your daily target in one bar.' : (phase === 'thinking' ? streamed?.text : answer?.display) || 'Ask Iris'}</p>
        <span className="figma-confidence">{demo && <img src="/figma/badge.svg" alt="" />}{sample ? 'Sample answer' : answer ? (demo ? 'Scripted demo answer' : latency + ' ms · answer time') : 'Tap the mic or type a question.'}</span>
      </div>
    </section>
    {(demo || nudge) && <button className="figma-context" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>
      {demo ? <img className="figma-product" src="/figma/product.png" alt="Dark chocolate almond bar on a dark surface" /> : <div className="figma-context-placeholder"><img src="/figma/scan.svg" alt="" /><span>YOUR VIEW</span></div>}
      <div className="figma-product-details"><span className="figma-recognition">{demo ? 'VISUAL MATCH · SAMPLE' : 'IN YOUR VIEW'}</span>
        <strong>{demo ? 'Dark cacao almond bar' : nudge?.text || 'No updates yet'}</strong>
        <p>{demo ? '1 bar · 52 g serving' : nudge ? 'Latest camera update' : 'Waiting for camera context'}</p>
        {demo && <div className="figma-nutrition"><span>214 kcal</span><img src="/figma/separator.svg" alt="" /><span>4 g sugar</span></div>}
      </div><img src="/figma/chevron.svg" alt="" />
    </button>}
    {detailsOpen && <section className="figma-extra">{demo ? 'This is the sample product from the Figma design, not a live camera observation.' : nudge?.reason || 'Camera updates will appear here when available.'}<a href="/dashboard">See the decision stream →</a></section>}
    <div className="figma-composer">
      <form onSubmit={e => { e.preventDefault(); void submit(question) }}><img src="/figma/wave.svg" alt="" /><label className="sr-only" htmlFor="question">OR TYPE A QUESTION</label><input id="question" placeholder="Ask a question…" value={question} disabled={busy} maxLength={2000} onChange={e => setQuestion(e.target.value)} /><button className={question.trim() ? 'figma-send' : 'sr-only'} aria-label="Send question" disabled={busy || !question.trim()}>↑</button></form>
      <button className="figma-mic" aria-label={phase === 'listening' ? 'Finish question' : 'Tap to talk'} disabled={phase === 'thinking'} onClick={listen}>{phase === 'listening' ? <span>■</span> : <img src="/figma/mic.svg" alt="" />}</button>
    </div>
    {spoken?.speak && <div className="figma-playback"><p>{spoken.speak}</p>{speaking && <button onClick={stopAudio}>Stop audio</button>}</div>}
    {error && <div role="alert" className="error-box">{error}{question.trim() && <button disabled={busy} onClick={() => void submit(question)}>Retry question</button>}</div>}
    {voiceNote && <p className="figma-note" role="status">{voiceNote}</p>}
    <OptionsDialog open={settingsOpen} onClose={onSettings}>
      <nav className="options-navigation" aria-label="Page navigation"><a href="/dashboard">Dashboard <span>Decisions and live metrics →</span></a><a href={'/garden?session=' + encodeURIComponent(session)}>Memory garden <span>Revisit a moment →</span></a></nav>
      {menu}
      <section className="figma-extra"><label className="wake-option"><input type="checkbox" checked={wakeWord} disabled={busy} onChange={e => setWakeWord(e.target.checked)} /> Start with “Iris” after tapping</label><p>{wake}</p><p>Voice uses browser speech services. Listening ends after each question.</p><p>{status} · {session}</p></section>
    </OptionsDialog>
    {demo && <p className="figma-demo-note">DEMO MODE · Scripted examples, no camera or brain connection. Answers are not observations.</p>}
  </main>
}

function Dashboard({ session, demo, sessionOnline }: { session: string; demo: boolean; sessionOnline: boolean }) {
  const { events, status: feedStatus } = useFeed(session, demo)
  const status = demo ? feedStatus : !sessionOnline ? 'Offline · session unavailable' : feedStatus
  const [filter, setFilter] = useState('all')
  const [paused, setPaused] = useState(false)
  const [snapshot, setSnapshot] = useState(events)
  const shown = paused ? snapshot : events
  const metrics = events.find(e => e.type === 'metrics')
  const latestAnswer = events.find(e => e.type === 'answer')
  const decisions = shown.filter(e => e.type === 'decision')
  const visible = shown.filter(e => filter === 'all' || e.type === 'decision' && e.level === filter)
  const latency = metrics?.answer_latency_ms_p50 ?? latestAnswer?.latency_ms
  const precision = metrics?.gate_precision
  return <main className="dashboard">
    <div className="dashboard-heading"><div><p className="eyebrow">Activity</p><h1>Dashboard</h1><p>Live decisions, response times, and session activity.</p></div><span className={'connection ' + (status === 'Connected' || demo ? 'online' : '')}><i />{status}</span></div>
    <div className="metrics-grid">
      <section className="panel metric"><p>Response time</p><strong>{latency !== undefined ? (latency / 1000).toFixed(2) : '—'}<small>{latency !== undefined ? ' s' : ''}</small></strong><span>{metrics ? 'Median latency · from the brain' : latestAnswer ? 'Latest answer · from the brain' : 'Awaiting an answer from the brain'}</span></section>
      <section className="panel metric"><p>Gate precision</p><strong>{precision != null ? Math.round(precision * 100) : '—'}<small>{precision != null ? '%' : ''}</small></strong><span>{precision == null ? 'not measured yet' : metrics?.gate_precision_basis || 'Measurement basis unavailable'}</span></section>
      <section className="panel metric"><p>Silent decisions</p><strong>{decisions.filter(e => e.level === 'silent').length}<small> / {decisions.length}</small></strong><span>Silent decisions · in this feed’s latest 200 events</span></section>
    </div>
    <section className="panel feed-panel"><div className="feed-heading"><div><h2>Decision stream</h2><p>{demo ? 'Scripted examples' : 'Live from the brain'} · {session}</p></div><button className="secondary" onClick={() => { if (!paused) setSnapshot(events); setPaused(!paused) }}>{paused ? 'Resume feed' : 'Pause feed'}</button></div>
      <div className="filters" aria-label="Filter decisions">{['all', 'silent', 'display', 'speak'].map(f => <button key={f} aria-pressed={filter === f} className={filter === f ? 'selected' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'All events' : f}</button>)}{paused && <span>VIEW PAUSED · still receiving</span>}</div>
      <div className="feed-table"><div className="feed-row table-labels"><span>TIME</span><span>DECISION</span><span>DETAILS</span></div>
        {!visible.length && <div className="feed-empty"><h3>{filter === 'all' ? 'No activity yet' : 'No matching decisions yet.'}</h3><p>{demo ? 'Sample decisions appear every few seconds.' : 'Start the brain with the same session ID, or enable demo mode to explore.'}</p></div>}
        {visible.map((event, i) => <div className="feed-row" key={event.at + i}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour12: false })}</time><span className={'badge ' + (event.level || event.type)}>{event.level || event.type.replace('_', ' ')}</span><div><p>{event.type === 'decision' ? event.text || 'Chose to stay quiet' : event.type === 'answer' ? event.display : event.type === 'answer_delta' ? event.text : event.type === 'memory_saved' ? event.description : 'Metrics updated'}</p><span>{event.reason || event.question || (event.type === 'metrics' ? 'Aggregate metrics received from the brain.' : event.type === 'answer_delta' ? 'Answer streaming · ' + event.ask_id : 'A moment added to memory.')}</span></div></div>)}
      </div>
    </section>
    <p className="dashboard-note">Precision is reported by the backend from test photos; it is never inferred from how often Iris speaks. Feed data is held in this tab, up to 200 events.</p>
  </main>
}

function OptionsDialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    if (!open) { element.close(); return }
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.showModal()
    return () => { element.close(); document.body.style.overflow = overflow }
  }, [open])
  return <dialog ref={dialog} className="options-dialog" aria-labelledby="options-title"
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="options-content">
      <header><div><p>IRIS</p><h2 id="options-title">Settings</h2></div><button autoFocus aria-label="Close menu" onClick={onClose}>×</button></header>
      {children}
    </div>
  </dialog>
}
