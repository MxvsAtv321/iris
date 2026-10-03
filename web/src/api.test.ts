import { describe, expect, it } from 'vitest'
import { isAnswer, parseEvent, stripWakeWord } from './api'
describe('backend contract validation', () => {
  it('accepts a silent decision without dropping its reason', () => {
    expect(parseEvent(JSON.stringify({ type: 'decision', session_id: 'judge-01', at: '2026-10-03T19:02:11Z', level: 'silent', text: '', reason: 'nothing new' }))?.reason).toBe('nothing new')
  })
  it('rejects malformed messages and invalid metrics', () => {
    expect(parseEvent('{')).toBeNull()
    expect(parseEvent(JSON.stringify({ type: 'metrics', session_id: 'j', at: new Date().toISOString(), gate_precision: 1.2, answer_latency_ms_p50: 50 }))).toBeNull()
    expect(parseEvent(JSON.stringify({ type: 'decision', session_id: 'j', at: 'bad', level: 'silent', text: '', reason: '' }))).toBeNull()
  })
  it('requires a supported level and nonnegative latency in answers', () => {
    expect(isAnswer({ display: '', speak: '', level: 'silent', latency_ms: 0 })).toBe(true)
    expect(isAnswer({ display: 'hi', speak: '', level: 'loud', latency_ms: 3 })).toBe(false)
    expect(isAnswer({ display: 'hi', speak: '', level: 'speak', latency_ms: -1 })).toBe(false)
  })
})
describe('wake phrase matching', () => {
  it('accepts common transcriptions at the beginning only', () => {
    expect(stripWakeWord('Hey Iris, what is this?')).toBe('what is this?')
    expect(stripWakeWord('Irish how much protein?')).toBe('how much protein?')
    expect(stripWakeWord('Aries, read this')).toBe('read this')
    expect(stripWakeWord('What is an iris?')).toBeNull()
    expect(stripWakeWord('Iris')).toBe('')
    expect(stripWakeWord('irises are flowers')).toBeNull()
  })
})

import { vi, afterEach } from 'vitest'
import { AudioLevel } from './audioLevel'
import { FrameBudget } from './irisShader'
afterEach(() => vi.unstubAllGlobals())
describe('iris performance budget', () => {
  it('keeps full quality at 60fps and degrades only after sustained slow frames', () => {
    const healthy = new FrameBudget()
    for (let t = 1; t < 5000; t += 1000 / 60) expect(healthy.sample(t)).toBe(false)
    const slow = new FrameBudget()
    let degraded = false
    for (let t = 1; t < 3000; t += 50) degraded ||= slow.sample(t)
    expect(degraded).toBe(true)
    slow.reset()
    expect(slow.sample(10000)).toBe(false)
  })
})
describe('iris audio meter', () => {
  it('releases a microphone granted after listening has stopped', async () => {
    let grant!: (stream: MediaStream) => void
    const stop = vi.fn()
    vi.stubGlobal('AudioContext', class { resume() { return Promise.resolve() } close() { return Promise.resolve() } })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(resolve => { grant = resolve }) } })
    const meter = new AudioLevel()
    const pending = meter.startMic()
    meter.stop()
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    await pending
    expect(stop).toHaveBeenCalledOnce()
    expect(meter.read()).toBe(0)
    meter.dispose()
  })
  it('measures PCM amplitude and disconnects without monitoring the mic aloud', async () => {
    const stop = vi.fn(), connect = vi.fn(), disconnect = vi.fn(), output = vi.fn()
    vi.stubGlobal('AudioContext', class {
      destination = {}
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
      createMediaStreamSource() { return { connect, disconnect } }
      createAnalyser() { return { fftSize: 0, connect: output, disconnect, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.1) } }
    })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } })
    const meter = new AudioLevel()
    await meter.startMic()
    expect(meter.read()).toBeCloseTo(0.644, 2)
    expect(output).not.toHaveBeenCalled()
    meter.dispose()
    expect(stop).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
})
