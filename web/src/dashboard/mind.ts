// What the dashboard knows about a session: the brain's decisions and answers, in order,
// and how they group into the thoughts the stream shows. No React here, so it can be tested.
import { parseEvent, type IrisEvent, type Level } from '../api'

export type Outcome = 'passed' | 'blocked' | 'softened' | 'not_checked'
export type RuleName = 'cooldown' | 'repeat' | 'quiet_after_answer' | 'rate_limit'
export type Rule = { rule: RuleName; outcome: Outcome; detail: string; similarity?: number; threshold?: number }
export type Skipped = 'no_change' | 'question_in_progress' | 'model_spacing' | 'error'
export type Trace = {
  frame_url: string | null; looked: boolean; skipped: Skipped | null
  change: { score: number; threshold: number } | null
  saw: string; why: string; topic: string; model: string | null
  candidate: { text: string; say: string }
  said_before: string   // the earlier line, when the model itself stayed quiet because the wearer was already told
  urgency: number | null; display_at: number; speak_at: number; proposed: Level
  rules: Rule[]; blocked_by: RuleName | null; verdict: Level
  latency_ms: { capture?: number; model?: number; gate?: number; total?: number }
}
export type Decision = IrisEvent & { type: 'decision'; level: Level; text: string; reason: string; trace: Trace }
export type AnswerEvent = IrisEvent & { type: 'answer'; question: string; display: string; speak: string; latency_ms: number }
export type MindEvent = Decision | AnswerEvent
export type Metrics = {
  answer_latency_ms_p50?: number | null; gate_accuracy?: number | null; gate_precision?: number | null
  gate_precision_basis?: string | null; watch_model?: string
  moments_seen?: number; moments_silent?: number; moments_shown?: number; moments_spoken?: number
}
export type Tally = { silent: number; display: number; speak: number }
export type Snapshot = { session_id: string | null; events: MindEvent[]; metrics: Metrics | null }
export type Mind = {
  loaded: boolean            // the brain has answered /api/trace at least once
  running: boolean           // a session is active on the brain
  sessionId: string | null   // the session these events belong to
  events: MindEvent[]        // oldest first
  metrics: Metrics | null
  tally: Tally
}
export const EMPTY: Mind = { loaded: false, running: false, sessionId: null, events: [], metrics: null, tally: { silent: 0, display: 0, speak: 0 } }
const KEEP = 1800   // the brain keeps the same number: an hour of frames

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// A decision from a brain without traces still shows, as a frame Iris didn't look closely at.
function traceOf(event: IrisEvent): Trace {
  const raw = (event as { trace?: unknown }).trace
  const t = object(raw) ? raw as Partial<Trace> : {}
  return {
    frame_url: typeof t.frame_url === 'string' ? t.frame_url : null,
    looked: t.looked === true,
    skipped: t.skipped ?? null,
    change: object(t.change) ? t.change : null,
    saw: String(t.saw || ''), why: String(t.why || ''), topic: String(t.topic || ''),
    model: typeof t.model === 'string' ? t.model : null,
    candidate: { text: String(t.candidate?.text || ''), say: String(t.candidate?.say || '') },
    said_before: String(t.said_before || ''),
    urgency: typeof t.urgency === 'number' ? t.urgency : null,
    display_at: typeof t.display_at === 'number' ? t.display_at : 5,
    speak_at: typeof t.speak_at === 'number' ? t.speak_at : 8,
    proposed: t.proposed ?? 'silent',
    rules: Array.isArray(t.rules) ? t.rules : [],
    blocked_by: t.blocked_by ?? null,
    verdict: event.level ?? 'silent',
    latency_ms: object(t.latency_ms) ? t.latency_ms : {},
  }
}

export function toMindEvent(event: IrisEvent | null): MindEvent | null {
  if (event?.type === 'decision') return { ...event, trace: traceOf(event) } as Decision
  if (event?.type === 'answer') return event as AnswerEvent
  return null
}

export function parseSnapshot(v: unknown): Snapshot | null {
  if (!object(v) || !Array.isArray(v.events)) return null
  const events = v.events.map(e => toMindEvent(parseEvent(JSON.stringify(e)))).filter((e): e is MindEvent => !!e)
  return {
    session_id: typeof v.session_id === 'string' ? v.session_id : null,
    events, metrics: object(v.metrics) ? v.metrics as Metrics : null,
  }
}

export const keyOf = (e: MindEvent) => e.type === 'decision' ? 'd:' + (e.frame_id || e.at) : 'a:' + (e.ask_id || e.at)

function tallyFrom(metrics: Metrics | null, fallback: Tally): Tally {
  if (typeof metrics?.moments_seen !== 'number') return fallback
  return { silent: metrics.moments_silent ?? 0, display: metrics.moments_shown ?? 0, speak: metrics.moments_spoken ?? 0 }
}

export type Action =
  | { type: 'snapshot'; snapshot: Snapshot; since: IrisEvent[] }   // `since`: events that arrived while it loaded
  | { type: 'event'; event: IrisEvent }

export function reduce(mind: Mind, action: Action): Mind {
  if (action.type === 'snapshot') {
    const { snapshot } = action
    const count = { silent: 0, display: 0, speak: 0 }
    for (const e of snapshot.events) if (e.type === 'decision') count[e.level]++
    const loaded: Mind = {
      loaded: true, running: snapshot.session_id !== null,
      sessionId: snapshot.session_id ?? snapshot.events.at(-1)?.session_id ?? null,
      events: snapshot.events, metrics: snapshot.metrics,
      tally: snapshot.session_id === null ? count : tallyFrom(snapshot.metrics, count),
    }
    return action.since.reduce((m, event) => reduce(m, { type: 'event', event }), loaded)
  }
  const { event } = action
  if (event.type === 'metrics') {
    const metrics = event as Metrics
    return { ...mind, metrics, tally: event.session_id === mind.sessionId ? tallyFrom(metrics, mind.tally) : mind.tally }
  }
  const next = toMindEvent(event)
  if (!next) return mind
  // Another session's first word means the brain moved on; so does this screen.
  const base = next.session_id === mind.sessionId ? mind : { ...mind, sessionId: next.session_id, events: [], tally: EMPTY.tally }
  const key = keyOf(next)
  if (base.events.slice(-200).some(e => keyOf(e) === key)) return base
  return {
    ...base, running: next.type === 'decision' ? true : base.running,
    events: [...base.events, next].slice(-KEEP),
    tally: next.type === 'decision' ? { ...base.tally, [next.level]: base.tally[next.level] + 1 } : base.tally,
  }
}

// ---------- the thought stream ----------

export type Lull = { kind: 'lull'; key: string; from: number; to: number; frames: number; why: Skipped | null; note: string }
export type Thought =
  | { kind: 'moment'; key: string; decision: Decision }
  | { kind: 'answer'; key: string; answer: AnswerEvent }
  | Lull

/** Oldest first. Frames Iris judged are moments; the runs of frames between them fold into one lull each. */
export function thoughts(events: MindEvent[]): Thought[] {
  const out: Thought[] = []
  for (const e of events) {
    if (e.type === 'answer') { out.push({ kind: 'answer', key: keyOf(e), answer: e }); continue }
    if (e.trace.looked) { out.push({ kind: 'moment', key: keyOf(e), decision: e }); continue }
    const at = Date.parse(e.at), last = out.at(-1)
    const note = e.trace.skipped === 'error' ? e.reason : ''
    if (last?.kind === 'lull' && last.why === e.trace.skipped) { last.to = at; last.frames++; last.note = note }
    else out.push({ kind: 'lull', key: 'l:' + keyOf(e), from: at, to: at, frames: 1, why: e.trace.skipped, note })
  }
  return out
}

/** How long a lull lasted, counting its last frame. `until` is the next thought, or now for the newest. */
export function lullLine(lull: Lull, until: number): string {
  const seconds = Math.max(2, Math.round((Math.max(until, lull.to) - lull.from) / 1000))
  const span = seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`
  switch (lull.why) {
    case 'no_change': return `Nothing changed for ${span}`
    case 'model_spacing': return `The scene moved. Waited ${span} before looking again`
    case 'question_in_progress': return `Held off for ${span} while answering a question`
    case 'error': return `Couldn’t see for ${span}`
    default: return `Watched for ${span}`
  }
}

/** Silenced on purpose: by one of the gate's rules, or by the model declining to repeat itself. */
export const heldBack = (d: Decision) => d.level === 'silent' && !!(d.trace.blocked_by || d.trace.said_before)

export const RULE_LABEL: Record<RuleName, string> = {
  cooldown: 'Cooldown', repeat: 'Repeat', quiet_after_answer: 'Quiet after an answer', rate_limit: 'Rate limit',
}

/** What Iris did with a moment, and why, as one plain sentence each. */
export function verdict(d: Decision): { did: string; because: string; heldBack: string; said: string; saidBefore: string } {
  const t = d.trace
  const line = t.candidate.say || t.candidate.text
  const none = { because: '', heldBack: '', said: '', saidBefore: '' }
  if (d.level === 'speak') return { ...none, did: 'Spoke', said: d.speak || d.text }
  if (d.level === 'display') {
    const softened = t.rules.find(r => r.outcome === 'softened')
    return { ...none, did: softened ? 'Showed a line instead of speaking' : 'Showed a line', because: softened ? sentence(softened.detail) : '', said: d.text || line }
  }
  const blocker = t.rules.find(r => r.rule === t.blocked_by)
  if (blocker) return { ...none, did: 'Stayed silent', because: `${RULE_LABEL[blocker.rule]}: ${sentence(blocker.detail, false)}`, heldBack: line }
  if (t.said_before) return { ...none, did: 'Stayed silent', because: 'Already said: Iris chose not to repeat itself.', saidBefore: t.said_before }
  if (t.urgency === null) return { ...none, did: 'Stayed silent', because: 'The model’s reply couldn’t be read.' }
  return { ...none, did: 'Stayed silent', because: `Urgency ${t.urgency} is under ${t.display_at}, where it would show a line.` }
}

function sentence(text: string, capital = true): string {
  const s = text.trim()
  if (!s) return ''
  return (capital ? s[0].toUpperCase() + s.slice(1) : s) + (/[.!?]$/.test(s) ? '' : '.')
}

export function ms(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '–'
  if (n < 1) return `${n.toFixed(2)} ms`
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`
}
