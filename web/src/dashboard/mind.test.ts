import { describe, expect, it } from 'vitest'
import type { IrisEvent } from '../api'
import { askLine, EMPTY, jevLine, lullLine, parseSnapshot, reduce, thoughts, verdict, type AnswerEvent, type Decision, type Lull, type Trace } from './mind'

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

describe('a question’s wait, step by step', () => {
  const answer = (trace?: unknown) => ({ type: 'answer', session_id: 'judge-01', at: at(40), ask_id: 'a_0001', question: 'what is this?',
    display: 'Almond protein bar', speak: 'That is an almond protein bar.', latency_ms: 1900, first_word_ms: 620, ...(trace ? { trace } : {}) }) as unknown as IrisEvent
  const timings = { mode: 'identify', frame: { source: 'recent', age_ms: 420 }, latency_ms: { wake: 2100, context: 4, first_word: 620, total: 1900 } }
  it('adds the steps that finish after the answer went out', () => {
    const before = load([answer(timings)])
    expect(askLine(before.events[0] as AnswerEvent)).toBe('Heard “Iris” 2.1 s before the question arrived. Used a frame 420 ms old. First word 620 ms, answer written 1.9 s.')
    const late = { type: 'answer_timing', session_id: 'judge-01', at: at(41), ask_id: 'a_0001',
      latency_ms: { ...timings.latency_ms, display: 910, speech: 1150, first_audio: 1400 } } as unknown as IrisEvent
    const after = reduce(before, { type: 'event', event: late })
    expect(after.events).toHaveLength(1)
    expect(askLine(after.events[0] as AnswerEvent)).toBe('Heard “Iris” 2.1 s before the question arrived. Used a frame 420 ms old. First word 620 ms, on the glasses 910 ms, voice playing 1.4 s, answer written 1.9 s.')
  })
  it('ignores a timing for a question it never saw, and still reads an answer without timings', () => {
    const mind = load([answer()])
    const stray = { type: 'answer_timing', session_id: 'judge-01', at: at(41), ask_id: 'a_0099', latency_ms: { first_audio: 5 } } as unknown as IrisEvent
    expect(reduce(mind, { type: 'event', event: stray })).toBe(mind)
    expect(askLine(mind.events[0] as AnswerEvent)).toBe('Answered in 1.9 s, first word at 620 ms.')
  })
  it('says when a new frame was taken, and shows the voice as ready until the phone reports it playing', () => {
    const mind = load([answer({ mode: 'ask', frame: { source: 'fresh', age_ms: 0 }, latency_ms: { context: 180, first_word: 700, display: 1100, speech: 1300, total: 1500 } })])
    expect(askLine(mind.events[0] as AnswerEvent)).toBe('Took a new frame. First word 700 ms, on the glasses 1.1 s, voice ready 1.3 s, answer written 1.5 s.')
  })
})

describe('System 1’s second opinion', () => {
  it('shows the probability, and the vision model’s own urgency when Jev changed it', () => {
    const mind = load([decision(1, 'silent', { ...looked, urgency: 3, jev: { probability: 0.31, model: 'openrouter:typesafe/jev-1.13', ms: 180, watch_urgency: 8 } })])
    expect(jevLine((mind.events[0] as Decision).trace)).toBe('Jev: 31% worth interrupting. The vision model alone said urgency 8.')
    const agreed = load([decision(1, 'speak', { ...looked, urgency: 9, jev: { probability: 0.9, model: 'm', ms: 150, watch_urgency: 9 } })])
    expect(jevLine((agreed.events[0] as Decision).trace)).toBe('Jev: 90% worth interrupting.')
  })
  it('says nothing when the gate ran without Jev', () => {
    const mind = load([decision(1, 'silent', looked), decision(2, 'silent', { ...looked, jev: 'broken' as never })])
    expect(mind.events.map(e => jevLine((e as Decision).trace))).toEqual(['', ''])
  })
})
