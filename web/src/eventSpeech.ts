import { askKey, reportFirstAudio, speechKey, type IrisEvent } from './api'
import { AudioLevel } from './audioLevel'

// Kept across route/session remounts so reconnects cannot replay a delivered ID.
const delivered = new Set<string>()
// Answers whose voice arrived as `speech` parts: the final `answer` must not be spoken again.
const inParts = new Set<string>()
type Line = { url: string; session: string; askId?: string; controller: AbortController; audio?: Promise<ArrayBuffer> }
export class EventSpeech {
  private unlocked = false
  private queue: Line[] = []
  private current: Line | null = null
  private disposed = false
  private asked: number | null = null   // when this phone sent a question whose voice hasn't started yet
  private meter: AudioLevel
  private speaking: (value: boolean) => void
  private note: (value: string) => void
  constructor(meter: AudioLevel, speaking: (value: boolean) => void, note: (value: string) => void) {
    this.meter = meter; this.speaking = speaking; this.note = note
  }
  unlock = () => {
    if (this.unlocked || this.disposed) return
    // Resume synchronously in the gesture handler, before any network request.
    void this.meter.unlock().then(() => {
      if (this.disposed) return
      this.unlocked = true
      this.note('')
      void this.drain()
    }).catch(() => this.note('Audio is unavailable. Iris’s words are shown on screen.'))
  }
  /** This phone just sent a question: the next answer's first audio is timed from now. */
  expect(sentAt: number) { this.asked = sentAt }
  receive = (event: IrisEvent) => {
    const key = speechKey(event)
    if (!key || delivered.has(key) || this.disposed) return
    delivered.add(key)
    if (event.type === 'speech') inParts.add(askKey(event))
    else if (event.type === 'answer' && inParts.has(key)) return   // already spoken, part by part
    const url = event.type === 'speech' ? event.audio_url! : '/api/tts?text=' + encodeURIComponent(event.speak!)
    this.queue.push({ url, session: event.session_id, askId: event.type === 'decision' ? undefined : event.ask_id, controller: new AbortController() })
    if (!this.unlocked) this.note('Tap anywhere to enable Iris’s voice.')
    this.load()
    void this.drain()
  }
  /** Start fetching the next lines now, so each is ready when the one before it ends. */
  private load() {
    if (!this.unlocked || this.disposed) return
    for (const line of this.queue.slice(0, 2)) {
      if (line.audio) continue
      const timeout = setTimeout(() => line.controller.abort(), 8000)
      line.audio = fetch(line.url, { signal: line.controller.signal }).then(response => {
        if (!response.ok || response.status === 204) throw new Error('No audio')
        return response.arrayBuffer()
      }).finally(() => clearTimeout(timeout))
      line.audio.catch(() => {})   // the failure is handled when the line's turn comes
    }
  }
  private async drain() {
    if (!this.unlocked || this.current || this.disposed || !this.queue.length) return
    this.load()
    const line = this.queue.shift()!
    this.current = line
    this.load()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const data = await line.audio!
      if (line.controller.signal.aborted) return
      timeout = setTimeout(() => line.controller.abort(), 30000)
      await this.meter.playVoice(data, line.controller.signal, () => {
        this.speaking(true)
        if (line.askId && this.asked !== null) {
          reportFirstAudio(line.session, line.askId, performance.now() - this.asked)
          this.asked = null
        }
      })
    } catch {
      if (!this.disposed && this.current === line) this.note('Voice unavailable. Iris’s words are shown on screen.')
    } finally {
      clearTimeout(timeout)
      if (this.current === line) {
        this.current = null
        if (!this.queue.length) this.speaking(false)   // stays "speaking" between the parts of one answer
        void this.drain()
      }
    }
  }
  stop() {
    for (const line of this.queue) line.controller.abort()
    this.queue = []
    this.current?.controller.abort()
    this.current = null
    this.meter.stop()
    this.speaking(false)
  }
  dispose() { this.disposed = true; this.stop() }
}
