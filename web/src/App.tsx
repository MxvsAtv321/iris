import { useEffect, useRef, useState } from 'react'
import { ask, stripWakeWord, type Answer } from './api'
import { useFeed } from './useFeed'
import { speechRecognition, type Recognition } from './voice'
import IrisVisual from './IrisVisual'
import { AudioLevel } from './audioLevel'
import './figma-phone.css'

type Phase = 'idle' | 'listening' | 'thinking' | 'answering' | 'error'
function initialSession() {
  try { return localStorage.getItem('iris-session') || 'judge-01' } catch { return 'judge-01' }
}
export default function App() {
  const [session, setSession] = useState(initialSession)
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
  return <div className={`app-shell ${!dashboard && !garden ? "phone-shell" : ""} ${settingsOpen ? "settings-open" : ""}`}>
    <header className="topbar"><a className="brand" href="/phone"><span className="identity-slot"><img src="/figma/identity.svg" alt="" /></span><span className="brand-copy"><strong>IRIS</strong><small>VISUAL INTELLIGENCE</small></span></a>
      <nav aria-label="Main navigation"><a className={!dashboard && !garden ? 'active' : ''} href="/phone">Companion</a><a className={dashboard ? 'active' : ''} href="/dashboard">Dashboard</a><a className={garden ? 'active' : ''} href="/garden">Garden</a></nav>
      <span className="edition">MHACKS ’26 <span> / </span> SEE · REMEMBER · ACT</span>
    </header>
    <div className="session-bar"><form onSubmit={e => { e.preventDefault(); changeSession() }}><label htmlFor="session">SESSION</label><input id="session" value={draft} maxLength={80} onChange={e => setDraft(e.target.value)} /><button disabled={!draft.trim() || draft.trim() === session}>Apply</button></form>
      <label className="demo-toggle"><input type="checkbox" checked={demo} onChange={e => setDemo(e.target.checked)} /> Demo mode</label>
    </div>
    {demo && (dashboard || garden) && <div className="demo-banner">DEMO MODE · Scripted examples, no camera or brain connection. Answers are not observations.</div>}
    {garden ? <main className="empty-page"><p className="eyebrow">REMEMBER / COMING TOGETHER</p><h1>A place for your memories.</h1><p>The memory garden is Darren’s part of Iris. This route is reserved for his viewer.</p><a href="/phone">Back to companion →</a></main> :
      dashboard ? <Dashboard key={session + demo} session={session} demo={demo} /> : <Phone key={session + demo} session={session} demo={demo} settingsOpen={settingsOpen} onSettings={() => setSettingsOpen(!settingsOpen)} />}
    <footer><span>KEEP YOUR GLASSES. SEE A LITTLE MORE.</span><span>IRIS / MHACKS 2026</span></footer>
  </div>
}
function Phone({ session, demo, settingsOpen, onSettings }: { session: string; demo: boolean; settingsOpen: boolean; onSettings: () => void }) {
  const { events, status } = useFeed(session, demo)
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
  const recognition = useRef<Recognition | null>(null)
  const request = useRef<AbortController | null>(null)
  const micTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const demoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const audioTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)
  const busy = phase === 'thinking' || phase === 'listening'
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false; recognition.current?.abort(); request.current?.abort(); audioLevel.dispose()
      clearTimeout(micTimer.current); clearTimeout(demoTimer.current); clearTimeout(audioTimer.current)
      window.speechSynthesis?.cancel()
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
  function stopAudio() {
    clearTimeout(audioTimer.current); window.speechSynthesis?.cancel(); audioLevel.stop(); setSpeaking(false)
  }
  function play(text: string) {
    stopAudio()
    if (!text) return
    if (!window.speechSynthesis) { setVoiceNote('Audio is unavailable here. Your answer is shown below.'); return }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.98
    utterance.onend = () => { clearTimeout(audioTimer.current); if (alive.current) { audioLevel.stop(); setSpeaking(false) } }
    utterance.onerror = () => { clearTimeout(audioTimer.current); if (alive.current) { audioLevel.stop(); setSpeaking(false); setVoiceNote('Audio could not play. Tap “Play answer” to retry.') } }
    utterance.onstart = () => { if (alive.current) { audioLevel.speechStart(); setSpeaking(true) } }
    utterance.onboundary = () => audioLevel.speechBoundary()
    window.speechSynthesis.speak(utterance)
    audioTimer.current = setTimeout(() => {
      if (alive.current) { stopAudio(); setVoiceNote('Playback stopped. You can replay the answer below.') }
    }, 30000)
  }
  async function submit(text: string) {
    const clean = text.trim()
    if (!clean || request.current) return
    stopAudio(); setQuestion(clean); setError(''); setVoiceNote(''); setAnswer(null); setLatency(null); setPhase('thinking')
    const controller = new AbortController()
    request.current = controller
    const started = performance.now()
    const timeout = setTimeout(() => controller.abort(), 25000)
    try {
      let result: Answer
      if (demo) {
        await new Promise<void>(resolve => { demoTimer.current = setTimeout(resolve, 900); controller.signal.addEventListener('abort', () => { clearTimeout(demoTimer.current); resolve() }, { once: true }) })
        if (controller.signal.aborted) return
        result = { display: 'Demo: 12g protein per bar', speak: 'This is a scripted demo answer: twelve grams of protein per bar. Connect the brain to ask about what you are actually seeing.', level: 'speak', latency_ms: 900 }
      } else result = await ask(session, clean, controller.signal)
      if (!alive.current) return
      setAnswer(result); setLatency(Math.round(performance.now() - started)); setPhase('answering')
      if (result.level === 'speak' && result.speak) play(result.speak)
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
  const nudge = events.find(e => e.type === 'decision' && e.level !== 'silent')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const sample = demo && !answer
  const protein = answer?.display.match(/(\d+(?:\.\d+)?)\s*g\s+protein/i)?.[1]
  const visualState = speaking ? 'speaking' : phase === 'listening' || phase === 'thinking' ? phase : 'idle'
  const stateLabel = speaking ? 'Speaking' : phase === 'thinking' ? 'Analyzing image' : phase === 'listening' ? 'Listening' : answer || sample ? 'Label resolved' : 'Ready when you are'
  return <main className="figma-phone" data-node-id="3:417">
    <header className="figma-header">
      <div className="figma-identity"><span className="identity-slot"><img src="/figma/identity.svg" alt="" /></span><div><strong>IRIS</strong><p>VISUAL INTELLIGENCE</p></div></div>
      <button className="figma-more" aria-label="More options" aria-expanded={settingsOpen} onClick={onSettings}><img src="/figma/more.svg" alt="" /></button>
    </header>
    <div className="figma-question-row"><div className="figma-question"><p>{question || (demo ? 'How much protein is in this?' : 'What would you like to know?')}</p><img src="/figma/scan.svg" alt="" /></div></div>
    <section className="figma-analysis" aria-label="Iris activity">
      <div className="figma-analysis-header"><span><span className="live-slot"><img src="/figma/live.svg" alt="" /></span>{stateLabel}</span><span>{demo ? 'DEMO' : status === 'Connected' ? 'LIVE' : 'OFFLINE'}</span></div>
      <IrisVisual state={visualState} readAmplitude={audioLevel.read} />
      <div className="figma-signal"><i /><span>{phase === 'error' ? 'Try again' : stateLabel}</span><i /></div>
    </section>
    <h1 className="sr-only" aria-live="polite">{phase === 'answering' ? 'Here’s what I found.' : phase === 'thinking' ? 'Taking a closer look.' : phase === 'listening' ? 'I’m listening.' : 'Iris visual assistant'}</h1>
    <section className={'figma-answer ' + (!(protein || sample) ? 'general-answer' : '')} aria-label="Answer" aria-live="polite">
      {(protein || sample) && <div className="figma-amount"><strong>{protein || '12'} g</strong><span>PROTEIN</span></div>}
      <div className="figma-answer-copy"><p>{sample ? 'About 24% of your daily target in one bar.' : answer?.display || 'Ask about what’s in front of you.'}</p>
        <span className="figma-confidence">{demo && <img src="/figma/badge.svg" alt="" />}{sample ? '96% label confidence · sample' : answer ? (demo ? 'Scripted demo answer' : latency + ' ms · answer time') : 'A little help, right when you need it.'}</span>
      </div>
    </section>
    <button className="figma-context" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>
      {demo ? <img className="figma-product" src="/figma/product.png" alt="Dark chocolate almond bar on a dark surface" /> : <div className="figma-context-placeholder"><img src="/figma/scan.svg" alt="" /><span>YOUR VIEW</span></div>}
      <div className="figma-product-details"><span className="figma-recognition"><img src="/figma/sparkles.svg" alt="" />{demo ? 'VISUAL MATCH · SAMPLE' : 'IN YOUR VIEW'}</span>
        <strong>{demo ? 'Dark cacao almond bar' : nudge?.text || 'Space for a useful thought'}</strong>
        <p>{demo ? '1 bar · 52 g serving' : nudge ? 'A gentle heads-up from Iris' : 'Waiting for camera context'}</p>
        {demo && <div className="figma-nutrition"><span>214 kcal</span><img src="/figma/separator.svg" alt="" /><span>4 g sugar</span></div>}
      </div><img src="/figma/chevron.svg" alt="" />
    </button>
    {detailsOpen && <section className="figma-extra">{demo ? 'This is the sample product from the Figma design, not a live camera observation.' : nudge?.reason || 'The current backend contract does not provide a product photo or nutrition metadata.'}<a href="/dashboard">See the decision stream →</a></section>}
    <div className="figma-composer">
      <form onSubmit={e => { e.preventDefault(); void submit(question) }}><img src="/figma/wave.svg" alt="" /><label className="sr-only" htmlFor="question">OR TYPE A QUESTION</label><input id="question" placeholder="Ask a follow-up" value={question} disabled={busy} maxLength={2000} onChange={e => setQuestion(e.target.value)} /><button className={question.trim() ? 'figma-send' : 'sr-only'} aria-label="Send question" disabled={busy || !question.trim()}>↑</button></form>
      <button className="figma-mic" aria-label={phase === 'listening' ? 'Finish question' : 'Tap to talk'} disabled={phase === 'thinking'} onClick={listen}>{phase === 'listening' ? <span>■</span> : <img src="/figma/mic.svg" alt="" />}</button>
    </div>
    {answer?.speak && <div className="figma-playback"><p>{answer.speak}</p><button onClick={() => speaking ? stopAudio() : play(answer.speak)}>{speaking ? 'Stop audio' : 'Play answer'}</button></div>}
    {error && <div role="alert" className="error-box">{error}{question.trim() && <button disabled={busy} onClick={() => void submit(question)}>Retry question</button>}</div>}
    {voiceNote && <p className="figma-note" role="status">{voiceNote}</p>}
    {settingsOpen && <section className="figma-extra"><label className="wake-option"><input type="checkbox" checked={wakeWord} disabled={busy} onChange={e => setWakeWord(e.target.checked)} /> Start with “Iris” after tapping</label><p>{wake}</p><p>Voice uses browser speech services. Listening ends after each question.</p><p>{status} · {session}</p></section>}
    {demo && <p className="figma-demo-note">DEMO MODE · Scripted examples, no camera or brain connection. Answers are not observations.</p>}
  </main>
}

function Dashboard({ session, demo }: { session: string; demo: boolean }) {
  const { events, status } = useFeed(session, demo)
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
    <div className="dashboard-heading"><div><p className="eyebrow">BEHIND THE THOUGHT</p><h1>Attention, thoughtfully given.</h1><p>Every decision. Even the ones you never hear.</p></div><span className={'connection ' + (status === 'Connected' || demo ? 'online' : '')}><i />{status}</span></div>
    <div className="metrics-grid">
      <section className="panel metric"><p>QUESTION → ANSWER <span>↗</span></p><strong>{latency !== undefined ? (latency / 1000).toFixed(2) : '—'}<small>{latency !== undefined ? ' s' : ''}</small></strong><span>{metrics ? 'Median latency · from the brain' : latestAnswer ? 'Latest answer · from the brain' : 'Awaiting an answer from the brain'}</span></section>
      <section className="panel metric"><p>GATE PRECISION <span>◎</span></p><strong>{precision !== undefined ? Math.round(precision * 100) : '—'}<small>{precision !== undefined ? '%' : ''}</small></strong><span>Correct interruptions / labeled interruptions</span></section>
      <section className="panel metric"><p>SPACE TO THINK <span>○</span></p><strong>{decisions.filter(e => e.level === 'silent').length}<small> / {decisions.length}</small></strong><span>Silent decisions · in this feed’s latest 200 events</span></section>
    </div>
    <section className="panel feed-panel"><div className="feed-heading"><div><h2>Decision stream</h2><p>{demo ? 'Scripted examples' : 'Live from the brain'} · {session}</p></div><button className="secondary" onClick={() => { if (!paused) setSnapshot(events); setPaused(!paused) }}>{paused ? 'Resume feed' : 'Pause feed'}</button></div>
      <div className="filters" aria-label="Filter decisions">{['all', 'silent', 'display', 'speak'].map(f => <button key={f} aria-pressed={filter === f} className={filter === f ? 'selected' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'All events' : f}</button>)}{paused && <span>VIEW PAUSED · still receiving</span>}</div>
      <div className="feed-table"><div className="feed-row table-labels"><span>TIME</span><span>DECISION</span><span>WHAT IRIS NOTICED / WHY</span></div>
        {!visible.length && <div className="feed-empty"><span>◎</span><h3>{filter === 'all' ? 'Listening for the first thought.' : 'No matching decisions yet.'}</h3><p>{demo ? 'Sample decisions appear every few seconds.' : 'Start the brain with the same session ID, or enable demo mode to explore.'}</p></div>}
        {visible.map((event, i) => <div className="feed-row" key={event.at + i}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour12: false })}</time><span className={'badge ' + (event.level || event.type)}>{event.level || event.type.replace('_', ' ')}</span><div><p>{event.type === 'decision' ? event.text || 'Chose to stay quiet' : event.type === 'answer' ? event.display : event.type === 'memory_saved' ? event.description : 'Metrics updated'}</p><span>{event.reason || event.question || (event.type === 'metrics' ? 'Aggregate metrics received from the brain.' : 'A moment added to memory.')}</span></div></div>)}
      </div>
    </section>
    <p className="dashboard-note">Precision is reported by the backend from labeled decisions; it is never inferred from how often Iris speaks. Feed data is held in this tab, up to 200 events.</p>
  </main>
}






