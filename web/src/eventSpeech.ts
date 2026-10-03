import { speechKey, type IrisEvent } from './api'
import { AudioLevel } from './audioLevel'

// Kept across route/session remounts so reconnects cannot replay a delivered ID.
const delivered = new Set<string>()
export class EventSpeech {
  private unlocked = false
  private queue: string[] = []
  private controller: AbortController | null = null
  private disposed = false
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
  receive = (event: IrisEvent) => {
    const key = speechKey(event)
    if (!key || delivered.has(key) || this.disposed) return
    delivered.add(key)
    this.queue.push(event.speak!)
    if (!this.unlocked) this.note('Tap anywhere to enable Iris’s voice.')
    void this.drain()
  }
  private async drain() {
    if (!this.unlocked || this.controller || this.disposed || !this.queue.length) return
    const text = this.queue.shift()!
    const controller = new AbortController()
    this.controller = controller
    let timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch('/api/tts?text=' + encodeURIComponent(text), { signal: controller.signal })
      if (!response.ok || response.status === 204) throw new Error('No audio')
      const data = await response.arrayBuffer()
      if (controller.signal.aborted) return
      clearTimeout(timeout)
      timeout = setTimeout(() => controller.abort(), 30000)
      await this.meter.playVoice(data, controller.signal, () => this.speaking(true))
    } catch {
      if (!this.disposed && this.controller === controller) this.note('Voice unavailable. Iris’s words are shown on screen.')
    } finally {
      clearTimeout(timeout)
      if (this.controller === controller) {
        this.controller = null
        this.speaking(false)
        void this.drain()
      }
    }
  }
  stop() {
    this.queue = []
    this.controller?.abort()
    this.controller = null
    this.meter.stop()
    this.speaking(false)
  }
  dispose() { this.disposed = true; this.stop() }
}
