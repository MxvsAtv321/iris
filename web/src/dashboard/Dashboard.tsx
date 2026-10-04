import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { keyOf, lullLine, ms, RULE_LABEL, thoughts, verdict, type AnswerEvent, type Decision, type Metrics, type MindEvent, type Tally, type Thought } from './mind'
import { useMind } from './useMind'
import './dashboard.css'

const clock = (at: string | number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
const isDecision = (e: MindEvent): e is Decision => e.type === 'decision'

function useNow(every: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

/** The dashboard only watches. It never calls POST or DELETE /api/session. */
export function Dashboard() {
  const { mind, connected } = useMind()
  const now = useNow(1000)
  const [pinned, setPinned] = useState<string | null>(null)
  const stream = useMemo(() => thoughts(mind.events).reverse(), [mind.events])   // newest first
  const decisions = useMemo(() => mind.events.filter(isDecision), [mind.events])
  const held = pinned ? decisions.find(d => keyOf(d) === pinned) : undefined
  const shown = held ?? decisions.at(-1)
  useEffect(() => {
    const release = (event: KeyboardEvent) => { if (event.key === 'Escape') setPinned(null) }
    window.addEventListener('keydown', release)
    return () => window.removeEventListener('keydown', release)
  }, [])

  const state = !connected ? 'offline' : !mind.loaded ? 'connecting' : mind.running ? 'live' : mind.events.length ? 'ended' : 'idle'
  const status = { offline: 'Brain offline, retrying', connecting: 'Connecting', live: 'Live', ended: 'Session ended', idle: 'No session running' }[state]
  const from = held ? stream.findIndex(t => t.key === pinned) : 0
  const visible = stream.slice(Math.max(0, from), Math.max(0, from) + 9)
  const focus = visible.find(t => t.kind === 'moment')?.key

  return <main className="mind" data-state={state}>
    <header className="mind-top">
      <h1>Iris <span>{mind.sessionId ? `session ${mind.sessionId}` : 'what the glasses are thinking'}</span></h1>
      <p className="mind-status" role="status"><i />{status}</p>
      <nav aria-label="Other pages"><a href="/phone">Companion</a><a href={mind.sessionId ? `/garden?session=${encodeURIComponent(mind.sessionId)}` : '/garden'}>Garden</a></nav>
    </header>

    <div className="mind-body">
      <div className="mind-left">
        <Frame decision={shown} held={!!held} state={state} onLive={() => setPinned(null)} />
        <Numbers metrics={mind.metrics} tally={mind.tally} events={mind.events} />
      </div>
      <section className="mind-stream" aria-label="Thought stream">
        {!visible.length && <p className="mind-quiet">{state === 'live' ? 'Waiting for the first look.' : 'Each moment Iris looks at will appear here: what it saw, what it considered, and what it decided.'}</p>}
        {visible.map((thought, i) => <Entry key={thought.key} thought={thought} depth={i} expanded={thought.key === focus}
          until={i === 0 && !held && state === 'live' ? now : i === 0 ? 0 : startOf(visible[i - 1])} held={thought.key === pinned}
          onPin={thought.kind === 'moment' ? () => setPinned(thought.key === pinned ? null : thought.key) : undefined} />)}
      </section>
    </div>

    <Timeline events={mind.events} now={state === 'live' ? now : 0} pinned={pinned} onPin={setPinned} />
  </main>
}

const startOf = (t: Thought) => t.kind === 'lull' ? t.from : Date.parse(t.kind === 'moment' ? t.decision.at : t.answer.at)

// ---------- the camera frame ----------

/** The last URL that finished loading, so the frame never flashes empty between ticks. */
function useLoaded(url: string | null) {
  const [loaded, setLoaded] = useState<{ url: string; aspect: number } | null>(null)
  const [missing, setMissing] = useState<string | null>(null)
  useEffect(() => {
    if (!url) return
    let current = true
    const image = new Image()
    image.onload = () => { if (current) { setLoaded({ url, aspect: image.naturalWidth / image.naturalHeight || 4 / 3 }); setMissing(null) } }
    image.onerror = () => { if (current) setMissing(url) }
    image.src = url
    return () => { current = false }
  }, [url])
  return { loaded, missing: missing === url }
}

function Frame({ decision, held, state, onLive }: { decision?: Decision; held: boolean; state: string; onLive: () => void }) {
  const trace = decision?.trace
  // A frame the brain couldn't capture has no picture of its own; the latest one it holds stands in.
  const { loaded, missing } = useLoaded(trace ? trace.frame_url ?? (held ? null : '/api/frame?at=' + decision.frame_id) : null)
  // The box belongs to the frame Iris last judged. Once the scene has moved on it is only where Iris last looked, so it dims.
  const box = decision?.focus_box ?? null
  const looking = !box ? 'false' : trace?.looked || trace?.skipped === 'no_change' ? 'true' : 'stale'
  const halo: Record<string, string> = box ? { '--hx': `${(box[0] + box[2] / 2) * 100}%`, '--hy': `${(box[1] + box[3] / 2) * 100}%`, '--hw': `${Math.max(box[2] / 2, .06) * 100}%`, '--hh': `${Math.max(box[3] / 2, .06) * 100}%` } : {}
  const empty = state === 'offline' ? 'Can’t reach the brain. This screen picks up again as soon as it is back.'
    : state === 'connecting' ? 'Connecting to the brain.'
    : state === 'idle' ? 'No session is running. Start one from the phone. This screen only watches.'
    : 'Waiting for the first frame.'
  return <figure className="mind-frame" data-level={decision?.level} data-looking={looking} style={{ '--aspect': loaded?.aspect ?? 4 / 3, ...halo } as CSSProperties}>
    {loaded ? <img src={loaded.url} alt={trace?.saw || 'What the glasses see'} /> : <p className="mind-empty">{empty}</p>}
    {loaded && <><div className="mind-shade" /><div className="mind-halo" /></>}
    {loaded && missing && <p className="mind-missing">That frame is no longer kept. This is the nearest one still loaded.</p>}
    {decision && loaded && <figcaption>
      <span>{held ? `Looking back at ${clock(decision.at)}` : state === 'live' ? `Seeing now, ${clock(decision.at)}` : `Last frame, ${clock(decision.at)}`}</span>
      {held && <button onClick={onLive}>Back to now</button>}
    </figcaption>}
  </figure>
}

// ---------- the thought stream ----------

function Entry({ thought, depth, expanded, until, held, onPin }: { thought: Thought; depth: number; expanded: boolean; until: number; held: boolean; onPin?: () => void }) {
  const style = { '--depth': depth } as CSSProperties
  if (thought.kind === 'lull') return <p className="mind-lull" style={style} title={thought.note || undefined}>{lullLine(thought, until)}.{thought.note ? ` ${thought.note}` : ''}</p>
  if (thought.kind === 'answer') return <Asked answer={thought.answer} style={style} />
  return <Moment decision={thought.decision} expanded={expanded} held={held} onPin={onPin} style={style} />
}

function Moment({ decision, expanded, held, onPin, style }: { decision: Decision; expanded: boolean; held: boolean; onPin?: () => void; style: CSSProperties }) {
  const t = decision.trace
  const v = verdict(decision)
  const checked = t.rules.some(r => r.outcome !== 'not_checked')
  const lat = t.latency_ms
  return <article className="mind-moment" data-level={decision.level} data-expanded={expanded} data-held={held} data-blocked={!!t.blocked_by} style={style}>
    <button className="mind-when" onClick={onPin} aria-pressed={held} title={held ? 'Back to now' : 'Show the frame Iris saw'}>{clock(decision.at)}</button>
    <dl>
      <div><dt>Saw</dt><dd>{t.saw || 'Nothing it could put into words.'}</dd></div>
      <div><dt>Considered</dt><dd>
        {t.why && t.why !== t.saw ? t.why : t.urgency === null ? 'No urgency came back.' : `Urgency ${t.urgency} of 10.`}
        {expanded && t.urgency !== null && <Urgency urgency={t.urgency} displayAt={t.display_at} speakAt={t.speak_at} />}
        {!expanded && t.urgency !== null && <span className="mind-aside"> Urgency {t.urgency}.</span>}
        {expanded && checked && <ol className="mind-rules">{t.rules.map(r => <li key={r.rule} data-outcome={r.outcome}>
          <span>{RULE_LABEL[r.rule]}</span>
          <span>{r.outcome === 'not_checked' ? 'not checked' : r.outcome}{r.similarity !== undefined ? `, similarity ${r.similarity.toFixed(2)} of ${r.threshold}` : ''}{r.detail ? `: ${r.detail}` : ''}</span>
        </li>)}</ol>}
      </dd></div>
      <div><dt>Decided</dt><dd className="mind-decided">
        <strong>{v.did}.</strong>{v.because && ` ${v.because}`}
        {v.said && <q>{v.said}</q>}
        {v.heldBack && <span className="mind-held">It had this ready: <q>{v.heldBack}</q></span>}
        {expanded && <span className="mind-latency">Capture {ms(lat.capture)}, model {ms(lat.model)}, gate {ms(lat.gate)}{t.model ? `, with ${t.model.split(':').pop()}` : ''}</span>}
      </dd></div>
    </dl>
  </article>
}

function Urgency({ urgency, displayAt, speakAt }: { urgency: number; displayAt: number; speakAt: number }) {
  const at = (n: number) => ({ left: `${Math.min(Math.max(n, 0), 10) * 10}%` })
  return <span className="mind-urgency" role="img" data-lit={urgency >= displayAt}
    aria-label={`Urgency ${urgency} of 10. Iris shows a line at ${displayAt} and speaks at ${speakAt}.`}>
    <i style={at(displayAt)}><em>shows at {displayAt}</em></i>
    <i style={at(speakAt)}><em>speaks at {speakAt}</em></i>
    <b style={at(urgency)}><em>{urgency}</em></b>
  </span>
}

function Asked({ answer, style }: { answer: AnswerEvent; style: CSSProperties }) {
  return <article className="mind-moment mind-asked" data-level="speak" style={style}>
    <span className="mind-when">{clock(answer.at)}</span>
    <dl>
      <div><dt>Asked</dt><dd>{answer.question}</dd></div>
      <div><dt>Answered</dt><dd className="mind-decided"><q>{answer.speak || answer.display}</q>
        <span className="mind-latency">Answered in {ms(answer.latency_ms)}{answer.first_word_ms ? `, first word at ${ms(answer.first_word_ms)}` : ''}</span></dd></div>
    </dl>
  </article>
}

// ---------- the numbers ----------

function Numbers({ metrics, tally, events }: { metrics: Metrics | null; tally: Tally; events: MindEvent[] }) {
  const lastAnswer = events.findLast(e => e.type === 'answer')
  const answer = metrics?.answer_latency_ms_p50 ?? lastAnswer?.latency_ms
  const accuracy = metrics?.gate_accuracy
  const seen = tally.silent + tally.display + tally.speak
  const times = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  return <dl className="mind-numbers">
    <div><dd>{answer != null ? (answer / 1000).toFixed(1) : '–'}{answer != null && <small> s</small>}</dd>
      <dt>Answer time{answer == null ? '. No questions yet.' : metrics?.answer_latency_ms_p50 != null ? ', median, question to answer' : ', latest question'}</dt></div>
    <div><dd>{accuracy != null ? Math.round(accuracy * 100) : '–'}{accuracy != null && <small>%</small>}</dd>
      <dt>Gate accuracy{accuracy != null ? `, ${metrics?.gate_precision_basis || 'measured on test photos'}` : '. Not measured on test photos yet.'}</dt></div>
    <div><dd>{seen.toLocaleString()}</dd>
      <dt>Moments seen. Spoke {times(tally.speak, 'time')}, showed {times(tally.display, 'line')}.</dt></div>
  </dl>
}

// ---------- the timeline ----------

function Timeline({ events, now, pinned, onPin }: { events: MindEvent[]; now: number; pinned: string | null; onPin: (key: string | null) => void }) {
  const points = useMemo(() => events.map(e => ({ e, key: keyOf(e), t: Date.parse(e.at) })), [events])
  const start = points[0]?.t ?? 0
  const end = Math.max(now, points.at(-1)?.t ?? 0, start + 120000)   // the first two minutes fill from the left
  const x = (t: number) => `${((t - start) / (end - start) * 100).toFixed(3)}%`
  function pick(event: React.MouseEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const t = start + (event.clientX - bounds.left) / bounds.width * (end - start)
    let best: { key: string; t: number } | null = null
    for (const p of points) if (p.e.type === 'decision' && p.e.trace.looked && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p
    onPin(best && best.key !== pinned ? best.key : null)
  }
  const pin = pinned ? points.find(p => p.key === pinned) : undefined
  return <footer className="mind-timeline">
    <svg onClick={pick} role="img" aria-label="Session timeline. Choose a point to see that moment.">
      <line className="tl-base" x1="0" x2="100%" y1="50%" y2="50%" />
      {pin && <line className="tl-pin" x1={x(pin.t)} x2={x(pin.t)} y1="0" y2="100%" />}
      {points.map(({ e, key, t }) => {
        if (e.type === 'answer') return <circle key={key} className="tl-answer" cx={x(t)} cy="50%" r="5" />
        if (e.level === 'speak') return <circle key={key} className="tl-speak" cx={x(t)} cy="50%" r="5" />
        if (e.level === 'display') return <circle key={key} className="tl-display" cx={x(t)} cy="50%" r="3.5" />
        if (e.trace.blocked_by) return <circle key={key} className="tl-held" cx={x(t)} cy="50%" r="3.5" />
        return <line key={key} className={e.trace.looked ? 'tl-looked' : 'tl-tick'} x1={x(t)} x2={x(t)} y1={e.trace.looked ? '22%' : '38%'} y2={e.trace.looked ? '78%' : '62%'} />
      })}
    </svg>
    <p><span>{start ? clock(start) : 'Session timeline'}</span>
      <span className="tl-legend"><i className="k-tick" />watching <i className="k-looked" />looked, stayed silent <i className="k-held" />held back by a rule <i className="k-display" />showed a line <i className="k-speak" />spoke <i className="k-answer" />answered a question</span>
      <span>{!start ? '' : now ? 'now' : clock(end)}</span></p>
  </footer>
}
