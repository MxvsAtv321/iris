import { describe, expect, it } from 'vitest'
import type { IrisEvent } from '../api'
import { EMPTY, lullLine, parseSnapshot, reduce, thoughts, verdict, type Decision, type Lull, type Trace } from './mind'

const at = (s: number) => new Date(Date.UTC(2026, 9, 4, 0, 0, s)).toISOString()
function decision(n: number, level: 'silent' | 'display' | 'speak', trace: Partial<Trace> = {}, session = 'judge-01') {
  return { type: 'decision', session_id: session, at: at(n * 2), level, text: '', speak: '', reason: 'r', frame_id: 'f_' + n, focus_box: null,
    trace: { looked: false, skipped: 'no_change', rules: [], candidate: { text: '', say: '' }, latency_ms: {}, ...trace } } as unknown as IrisEvent
}
const looked = { looked: true, skipped: null, saw: 'a desk', urgency: 2 } as Partial<Trace>
const load = (events: IrisEvent[], session: string | null = 'judge-01') =>
  reduce(EMPTY, { type: 'snapshot', snapshot: parseSnapshot({ session_id: session, events, metrics: null })!, since: [] })

describe('the dashboard’s picture of a session', () => {
  it('does not count an event twice when the snapshot and the socket both carry it', () => {
    const mind = reduce(EMPTY, { type: 'snapshot', snapshot: parseSnapshot({ session_id: 'judge-01', events: [decision(1, 'silent')], metrics: null })!,
      since: [decision(1, 'silent'), decision(2, 'speak', looked)] })
    expect(mind.events.map(e => e.frame_id)).toEqual(['f_1', 'f_2'])
    expect(mind.tally).toEqual({ silent: 1, display: 0, speak: 1 })
  })
  it('follows the brain to a new session and starts its counts again', () => {
    const mind = reduce(load([decision(1, 'speak', looked)]), { type: 'event', event: decision(1, 'silent', {}, 'judge-02') })
    expect(mind.sessionId).toBe('judge-02')
    expect(mind.events).toHaveLength(1)
    expect(mind.tally).toEqual({ silent: 1, display: 0, speak: 0 })
  })
  it('keeps the last session on screen after it stops', () => {
    const mind = load([decision(1, 'silent', looked)], null)
    expect([mind.running, mind.sessionId, mind.events.length]).toEqual([false, 'judge-01', 1])
  })
  it('takes its counts from the brain, which has seen the whole session', () => {
    const metrics = { type: 'metrics', session_id: 'judge-01', at: at(9), answer_latency_ms_p50: null, gate_precision: null,
      moments_seen: 4000, moments_silent: 3990, moments_shown: 7, moments_spoken: 3 } as unknown as IrisEvent
    expect(reduce(load([decision(1, 'silent')]), { type: 'event', event: metrics }).tally).toEqual({ silent: 3990, display: 7, speak: 3 })
  })
  it('shows a decision from a brain without traces as a frame it only watched', () => {
    const old = { type: 'decision', session_id: 'judge-01', at: at(1), level: 'silent', text: '', reason: 'no change', frame_id: 'f_1' }
    const stream = thoughts(load([old as IrisEvent]).events)
    expect(stream).toHaveLength(1)
    expect(stream[0].kind).toBe('lull')
  })
})

describe('the thought stream', () => {
  it('folds the frames between two looks into one line', () => {
    const stream = thoughts(load([decision(1, 'silent', looked), decision(2, 'silent'), decision(3, 'silent'), decision(4, 'silent'),
      decision(5, 'silent', { skipped: 'model_spacing' }), decision(6, 'silent', looked)]).events)
    expect(stream.map(t => t.kind)).toEqual(['moment', 'lull', 'lull', 'moment'])
    expect((stream[1] as Lull).frames).toBe(3)
    expect(lullLine(stream[1] as Lull, Date.parse(at(10)))).toBe('Nothing changed for 6 s')
  })
  it('names the rule that silenced a moment and what was held back', () => {
    const blocked = decision(1, 'silent', { ...looked, urgency: 9, blocked_by: 'cooldown', candidate: { text: 'Line 2: 7x8 is 56', say: 'Line 2 should be fifty-six.' },
      rules: [{ rule: 'cooldown', outcome: 'blocked', detail: "nudged about 'math' 10 s ago; one per 120 s" }] })
    const v = verdict(load([blocked]).events[0] as Decision)
    expect(v).toEqual({ did: 'Stayed silent', because: "Cooldown: nudged about 'math' 10 s ago; one per 120 s.", heldBack: 'Line 2 should be fifty-six.', said: '' })
  })
  it('says an ordinary moment was simply under the bar', () => {
    const v = verdict(load([decision(1, 'silent', { ...looked, display_at: 5 })]).events[0] as Decision)
    expect(v.because).toBe('Urgency 2 is under 5, where it would show a line.')
  })
})
