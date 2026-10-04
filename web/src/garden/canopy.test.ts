import { describe, expect, it } from 'vitest'
import type { IrisEvent } from '../api'
import { EMPTY, MAX_THREADS, blossomFor, grow, keywordsOf, sproutFromEvent, sproutFromMoment, tieByMeaning, type Sprout } from './canopy'

const decision = (over: Partial<IrisEvent>): IrisEvent => ({
  type: 'decision', session_id: 'judge-01', at: '2026-10-03T19:02:11Z', level: 'silent', text: '', reason: 'no change', frame_id: 'f_1', ...over,
})
const sprout = (id: string, over: Partial<Sprout> = {}): Sprout => ({ id, kind: 'display', at: 1, line: '', reason: '', momentId: null, ...over })

describe('keywordsOf', () => {
  it('keeps the things Iris saw and drops filler and the gate\'s own phrasing', () => {
    expect(keywordsOf('urgency 9: arithmetic error on whiteboard')).toEqual(['arithmetic', 'whiteboard'])
    expect(keywordsOf('scene changed; next model call in 4s')).toEqual([])
    expect(keywordsOf('no change')).toEqual([])
  })
  it('folds plurals so keys and key connect', () => {
    expect(keywordsOf('phone, keys, laptop')).toEqual(['phone', 'key', 'laptop'])
  })
})

describe('sproutFromEvent', () => {
  it('turns a decision into a leaf of its level', () => {
    const s = sproutFromEvent(decision({ level: 'speak', text: 'Line 2: 7x8 is 56', speak: 'Line 2 says fifty-four.', reason: 'urgency 9', frame_id: 'f_0192' }))
    expect(s).toMatchObject({ id: 'd:f_0192', kind: 'speak', line: 'Line 2 says fifty-four.', reason: 'urgency 9', momentId: null })
  })
  it('keeps silent decisions, as faint leaves', () => {
    expect(sproutFromEvent(decision({}))).toMatchObject({ kind: 'silent', line: '' })
  })
  it('turns an answer into a leaf where Iris spoke', () => {
    const s = sproutFromEvent({ type: 'answer', session_id: 's', at: '2026-10-03T19:02:11Z', ask_id: 'a_7', question: 'how much protein?', display: '12g', speak: 'About 12 grams.', latency_ms: 900 })
    expect(s).toMatchObject({ id: 'a:a_7', kind: 'speak', line: 'About 12 grams.', reason: 'You asked: how much protein?' })
  })
  it('turns a saved memory into a blossom', () => {
    const s = sproutFromEvent({ type: 'memory_saved', session_id: 's', at: '2026-10-03T19:02:11Z', moment_id: 42, description: 'phone, mug' })
    expect(s).toMatchObject({ id: 'm:42', kind: 'blossom', momentId: 42, line: 'phone, mug' })
  })
  it('ignores events that are not moments', () => {
    expect(sproutFromEvent({ type: 'metrics', session_id: 's', at: '2026-10-03T19:02:11Z' })).toBeNull()
    expect(sproutFromEvent({ type: 'answer_delta', session_id: 's', at: '2026-10-03T19:02:11Z', ask_id: 'a', text: 'x' })).toBeNull()
  })
})

describe('grow', () => {
  it('gives each new leaf the next slot and remembers when it sprouted', () => {
    const c = grow(EMPTY, [sprout('a'), sprout('b')], 500, 100)
    expect(c.leaves.map((l) => [l.id, l.slot, l.born])).toEqual([['a', 0, 500], ['b', 1, 500]])
  })
  it('never grows the same moment twice, whether it arrives live or from memory', () => {
    const live = sproutFromEvent({ type: 'memory_saved', session_id: 's', at: '2026-10-03T19:02:11Z', moment_id: 42, description: 'phone' })!
    const listed = sproutFromMoment({ id: 42, captured_at: '2026-10-03T19:02:11Z', description: 'phone', has_depth: false, image_url: '', depth_url: '' })
    const once = grow(EMPTY, [live], 1, 100)
    expect(grow(once, [listed, listed], 2, 100)).toBe(once)
  })
  it('lets the newest leaf take the oldest place when the tree is full', () => {
    let c = grow(EMPTY, [sprout('a'), sprout('b'), sprout('c')], 1, 3)
    c = grow(c, [sprout('d')], 2, 3)
    expect(c.leaves.map((l) => l.id)).toEqual(['b', 'c', 'd'])
    expect(c.leaves.find((l) => l.id === 'd')?.slot).toBe(0)
  })
  it('ties a leaf to the most recent leaf about the same thing', () => {
    let c = grow(EMPTY, [sprout('a', { reason: 'a whiteboard with sums' }), sprout('b', { reason: 'a coffee mug' })], 1, 100)
    c = grow(c, [sprout('c', { line: 'Check the whiteboard' })], 2, 100)
    expect(c.threads).toEqual([{ a: 'a', b: 'c', why: 'whiteboard', born: 2 }])
  })
  it('does not tie two silent leaves together', () => {
    const c = grow(EMPTY, [sprout('a', { kind: 'silent', reason: 'whiteboard unchanged' }), sprout('b', { kind: 'silent', reason: 'whiteboard unchanged' })], 1, 100)
    expect(c.threads).toEqual([])
  })
  it('drops threads whose leaf has been replaced, and never keeps more than the cap', () => {
    let c = grow(EMPTY, [sprout('a', { reason: 'mug' }), sprout('b', { reason: 'mug' })], 1, 2)
    expect(c.threads.length).toBe(1)
    c = grow(c, [sprout('c', { reason: 'lamp' })], 2, 2)
    expect(c.threads).toEqual([])
    let big = EMPTY
    for (let i = 0; i < MAX_THREADS + 40; i++) big = grow(big, [sprout(`n${i}`, { reason: 'mug' })], i, 1000)
    expect(big.threads.length).toBe(MAX_THREADS)
  })
})

describe('tieByMeaning', () => {
  it('threads a found memory to the ones memory search ranks closest', () => {
    const c = grow(EMPTY, [sprout('m:1', { kind: 'blossom', momentId: 1 }), sprout('m:2', { kind: 'blossom', momentId: 2 }), sprout('m:3', { kind: 'blossom', momentId: 3 })], 1, 100)
    const tied = tieByMeaning(c, 1, [1, 2, 9], 5)
    expect(tied.threads).toEqual([{ a: 'm:1', b: 'm:2', why: 'close in meaning', born: 5 }])
    expect(tieByMeaning(tied, 1, [2], 6)).toBe(tied)
  })
})

describe('blossomFor', () => {
  it('finds the newest blossom that mentions what was asked about', () => {
    const c = grow(EMPTY, [
      sprout('m:1', { kind: 'blossom', momentId: 1, at: 10, line: 'phone, mug. A desk by the window.' }),
      sprout('m:2', { kind: 'blossom', momentId: 2, at: 20, line: 'phone, keys. The kitchen counter.' }),
      sprout('d:1', { kind: 'speak', line: 'Your phone is ringing' }),
    ], 1, 100)
    expect(blossomFor(c, 'where did I leave my phone?')?.id).toBe('m:2')
    expect(blossomFor(c, 'where is my umbrella?')).toBeNull()
  })
})
