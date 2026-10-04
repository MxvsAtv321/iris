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

import { appendEvent, speechKey, startSession, type IrisEvent } from './api'
import { EventSpeech } from './eventSpeech'

const eventBase = { session_id: 'tests', at: '2026-10-03T19:02:11Z' }
describe('current Brain events', () => {
  it('accepts nullable metrics and retains model and measurement fields', () => {
    const metrics = { ...eventBase, type: 'metrics', gate_precision: null, answer_latency_ms_p50: null,
      gate_precision_basis: null, model_calls_today: 112, model_usd_today: 0.41, ask_model: 'ask', watch_model: 'watch' }
    expect(parseEvent(JSON.stringify(metrics))).toEqual(metrics)
    expect(parseEvent(JSON.stringify({ ...metrics, gate_precision: 0.9, gate_precision_basis: 'measured on 10 test photos' }))?.gate_precision_basis).toBe('measured on 10 test photos')
  })
  it('accepts numeric memory IDs and decision focus and speech', () => {
    expect(parseEvent(JSON.stringify({ ...eventBase, type: 'memory_saved', moment_id: 42, description: 'phone' }))?.moment_id).toBe(42)
    const decision = { ...eventBase, type: 'decision', level: 'speak', text: 'Check line 2', speak: 'Check the math', reason: 'error', frame_id: 'f1', focus_box: [0.1, 0.2, 0.3, 0.4] }
    expect(parseEvent(JSON.stringify(decision))).toEqual(decision)
    expect(parseEvent(JSON.stringify({ ...decision, focus_box: null }))?.focus_box).toBeNull()
  })
  it('appends interleaved deltas by ask ID and replaces them with the final answer', () => {
    let events: IrisEvent[] = []
    for (const [ask_id, text] of [['a', '12g'], ['b', 'Other'], ['a', ' protein']]) {
      const delta = parseEvent(JSON.stringify({ ...eventBase, type: 'answer_delta', ask_id, text }))!
      expect(delta).not.toBeNull()
      events = appendEvent(events, delta)
    }
    expect(events.find(e => e.ask_id === 'a')?.text).toBe('12g protein')
    expect(events.find(e => e.ask_id === 'b')?.text).toBe('Other')
    const final = parseEvent(JSON.stringify({ ...eventBase, type: 'answer', ask_id: 'a', question: '?', display: '12g protein', speak: '', latency_ms: 90, first_word_ms: 30 }))!
    events = appendEvent(events, final)
    expect(events.filter(e => e.ask_id === 'a')).toEqual([final])
    expect(appendEvent(events, { ...eventBase, type: 'answer_delta', ask_id: 'a', text: 'late' })).toEqual(events)
  })
})
describe('session startup', () => {
  it('posts the session ID and reports server/network failures without throwing', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetcher)
    expect(await startSession('judge-02')).toBe(true)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ session_id: 'judge-02' })
    expect(await startSession('judge-03')).toBe(false)
    expect(await startSession('judge-04')).toBe(false)
  })
  it('aborts startup after four seconds', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(new Error('aborted')))
      }))
      const pending = startSession('slow')
      await vi.advanceTimersByTimeAsync(4000)
      expect(await pending).toBe(false)
    } finally { vi.useRealTimers() }
  })
})
describe('WebSocket speech', () => {
  function setup() {
    const meter = { unlock: vi.fn().mockResolvedValue(undefined), playVoice: vi.fn().mockResolvedValue(undefined), stop: vi.fn() }
    const note = vi.fn()
    return { meter, note, voice: new EventSpeech(meter as unknown as AudioLevel, vi.fn(), note) }
  }
  it('waits for a tap and plays each frame/ask once, ignoring silent and display events', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) })
    vi.stubGlobal('fetch', fetcher)
    const { voice, meter } = setup()
    const decision: IrisEvent = { ...eventBase, type: 'decision', level: 'speak', frame_id: 'unique-frame', speak: 'Hello & welcome' }
    voice.receive({ ...decision, level: 'silent' })
    voice.receive({ ...decision, level: 'display' })
    voice.receive(decision); voice.receive(decision)
    expect(fetcher).not.toHaveBeenCalled()
    voice.unlock()
    await vi.waitFor(() => expect(meter.playVoice).toHaveBeenCalledOnce())
    expect(fetcher.mock.calls[0][0]).toBe('/api/tts?text=Hello%20%26%20welcome')
    const answer: IrisEvent = { ...eventBase, type: 'answer', ask_id: 'unique-ask', speak: 'Answer' }
    voice.receive(answer); voice.receive(answer)
    await vi.waitFor(() => expect(meter.playVoice).toHaveBeenCalledTimes(2))
    voice.dispose()
    const next = setup()
    next.voice.unlock(); next.voice.receive(answer)
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(2)
    next.voice.dispose()
  })
  it('plays an answer part by part from the brain’s audio, and not again when the whole answer arrives', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(url).buffer }))
    vi.stubGlobal('fetch', fetcher)
    const { voice, meter } = setup()
    voice.unlock()
    const part = (seq: number, text: string) => parseEvent(JSON.stringify({ ...eventBase, type: 'speech', ask_id: 'parts-ask', seq, text, audio_url: '/api/tts/s_000' + seq }))!
    expect(part(0, 'First.')).not.toBeNull()
    voice.receive(part(0, 'First.')); voice.receive(part(0, 'First.')); voice.receive(part(1, 'Second.'))
    voice.receive({ ...eventBase, type: 'answer', ask_id: 'parts-ask', speak: 'First. Second.' })
    await vi.waitFor(() => expect(meter.playVoice).toHaveBeenCalledTimes(2))
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/tts/s_0000', '/api/tts/s_0001'])
    expect(meter.playVoice.mock.calls.map(call => new TextDecoder().decode(call[0]))).toEqual(['/api/tts/s_0000', '/api/tts/s_0001'])
    voice.dispose()
  })
  it('reports the first audio of the question this phone sent, once', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => url === '/api/timing' ? { ok: true, status: 200 } : { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) })
    vi.stubGlobal('fetch', fetcher)
    const { voice, meter } = setup()
    meter.playVoice.mockImplementation(async (_data: ArrayBuffer, _signal: AbortSignal, started: () => void) => started())
    voice.unlock()
    voice.expect(performance.now() - 1200)
    voice.receive({ ...eventBase, type: 'speech', ask_id: 'timed-ask', seq: 0, text: 'First.', audio_url: '/api/tts/s_0007' })
    voice.receive({ ...eventBase, type: 'speech', ask_id: 'timed-ask', seq: 1, text: 'Second.', audio_url: '/api/tts/s_0008' })
    await vi.waitFor(() => expect(meter.playVoice).toHaveBeenCalledTimes(2))
    const reports = fetcher.mock.calls.filter(call => call[0] === '/api/timing')
    expect(reports).toHaveLength(1)
    const body = JSON.parse(reports[0][1].body)
    expect(body).toMatchObject({ session_id: 'tests', ask_id: 'timed-ask' })
    expect(body.first_audio_ms).toBeGreaterThanOrEqual(1200)
    voice.dispose()
  })
  it('validates speech and timing events, and keeps them out of the event list', () => {
    const speech = { ...eventBase, type: 'speech', ask_id: 'a', seq: 0, text: 'Hi.', audio_url: '/api/tts/s_0001' }
    expect(speechKey(parseEvent(JSON.stringify(speech))!)).toBe('tests:ask:a:0')
    expect(parseEvent(JSON.stringify({ ...speech, audio_url: 'https://elsewhere.example/x.mp3' }))).toBeNull()
    expect(parseEvent(JSON.stringify({ ...speech, seq: undefined }))).toBeNull()
    const timing = parseEvent(JSON.stringify({ ...eventBase, type: 'answer_timing', ask_id: 'a', latency_ms: { first_audio: 900 } }))!
    expect(timing).not.toBeNull()
    expect(parseEvent(JSON.stringify({ ...eventBase, type: 'answer_timing', ask_id: 'a' }))).toBeNull()
    expect(appendEvent(appendEvent([], parseEvent(JSON.stringify(speech))!), timing)).toEqual([])
  })
  it.each([204, 500])('keeps text available when TTS returns %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status < 400, status }))
    const { voice, meter, note } = setup()
    voice.unlock()
    voice.receive({ ...eventBase, type: 'answer', ask_id: 'unavailable-' + status, speak: 'Visible answer' })
    await vi.waitFor(() => expect(note).toHaveBeenCalledWith('Voice unavailable. Iris’s words are shown on screen.'))
    expect(meter.playVoice).not.toHaveBeenCalled()
    voice.dispose()
  })
})
