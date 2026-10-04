export type Level = 'silent' | 'display' | 'speak'
export type Answer = { display: string; speak: string; level: Level; latency_ms: number }
export type IrisEvent = {
  type: 'decision' | 'answer' | 'answer_delta' | 'metrics' | 'memory_saved' | 'speech' | 'answer_timing'; session_id: string; at: string;
  level?: Level; text?: string; reason?: string; frame_id?: string; question?: string;
  display?: string; speak?: string; latency_ms?: number; answer_latency_ms_p50?: number | null;
  gate_precision?: number | null; moment_id?: string | number;
  focus_box?: [number, number, number, number] | null; ask_id?: string; first_word_ms?: number;
  gate_precision_basis?: string | null; model_calls_today?: number; model_usd_today?: number;
  ask_model?: string; watch_model?: string; answer_latency_ms_p95?: number | null; first_word_ms_p50?: number | null; description?: string;
  seq?: number; audio_url?: string;   // speech: one part of an answer's voice, already being fetched by the brain
}
/** What the phone measured before it sent the question, in ms. */
export type AskMarks = { wake_ms?: number; listen_ms?: number }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const level = (v: unknown): v is Level => ['silent', 'display', 'speak'].includes(v as string)
export function isAnswer(v: unknown): v is Answer {
  return object(v) && typeof v.display === 'string' && typeof v.speak === 'string' && level(v.level) && finite(v.latency_ms)
}
export function parseEvent(raw: string): IrisEvent | null {
  try {
    const v: unknown = JSON.parse(raw)
    if (!object(v) || typeof v.session_id !== 'string' || typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) return null
    switch (v.type) {
      case 'decision': if (!level(v.level) || typeof v.text !== 'string' || typeof v.reason !== 'string') return null; break
      case 'answer': if (typeof v.question !== 'string' || typeof v.display !== 'string' || typeof v.speak !== 'string' || !finite(v.latency_ms)) return null; break
      case 'answer_delta': if (typeof v.ask_id !== 'string' || typeof v.text !== 'string') return null; break
      case 'metrics': if (!(v.answer_latency_ms_p50 === null || finite(v.answer_latency_ms_p50)) || !(v.gate_precision === null || finite(v.gate_precision) && v.gate_precision <= 1)) return null; break
      case 'speech': if (typeof v.ask_id !== 'string' || typeof v.text !== 'string' || !finite(v.seq) || typeof v.audio_url !== 'string' || !v.audio_url.startsWith('/api/tts/')) return null; break
      case 'answer_timing': if (typeof v.ask_id !== 'string' || !object(v.latency_ms)) return null; break
      case 'memory_saved': if ((typeof v.moment_id !== 'string' && !finite(v.moment_id)) || typeof v.description !== 'string') return null; break
      default: return null
    }
    return v as IrisEvent
  } catch { return null }
}
export async function ask(session_id: string, text: string, signal: AbortSignal, marks: AskMarks = {}): Promise<Answer> {
  const response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id, text, ...marks }), signal })
  if (!response.ok) throw new Error(response.status >= 500 ? 'The brain is unavailable. Check that FastAPI is running.' : 'The brain could not accept this question. Try again.')
  const answer: unknown = await response.json()
  if (!isAnswer(answer)) throw new Error('The brain returned an unexpected answer format.')
  return answer
}
export function stripWakeWord(text: string): string | null {
  const match = text.trim().match(/^(?:hey\s+)?(?:iris|iriss|eyeris|irish|aries)\b[\s,.!?;:]*/i)
  return match ? text.trim().slice(match[0].length).trim() : null
}

// The wake word was heard: the eye on the glasses opens and listens, and the brain gets a frame and its
// connections ready for the question. With eye false (the mic opened, no wake word yet) it only gets ready.
// Fire and forget, never throws.
export function wakeEye(session_id: string, eye = true): void {
  void fetch('/api/wake', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id, eye }), signal: AbortSignal.timeout(2000),
  }).catch(() => {})
}

// The answer's voice started playing: tell the brain how long that took from sending the question,
// so the dashboard shows the whole wait. Fire and forget, never throws.
export function reportFirstAudio(session_id: string, ask_id: string, first_audio_ms: number): void {
  void fetch('/api/timing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id, ask_id, first_audio_ms: Math.round(first_audio_ms) }), signal: AbortSignal.timeout(2000),
  }).catch(() => {})
}

export async function startSession(session_id: string, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(abort, 4000)
  try {
    const response = await fetch('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }), signal: controller.signal,
    })
    return response.ok
  } catch { return false }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}

// Coalesce each question's deltas independently, then replace them with its final answer.
export function appendEvent(events: IrisEvent[], event: IrisEvent): IrisEvent[] {
  if (event.type === 'speech' || event.type === 'answer_timing') return events   // acted on as they arrive, never listed
  if (event.type === 'answer_delta') {
    if (events.some(e => e.type === 'answer' && e.ask_id === event.ask_id)) return events
    const prior = events.find(e => e.type === 'answer_delta' && e.ask_id === event.ask_id)
    return [{ ...event, text: (prior?.text || '') + event.text },
      ...events.filter(e => !(e.type === 'answer_delta' && e.ask_id === event.ask_id))].slice(0, 200)
  }
  return [event, ...events.filter(e => !(event.type === 'answer' && event.ask_id && e.type === 'answer_delta' && e.ask_id === event.ask_id))].slice(0, 200)
}
export const askKey = (event: IrisEvent) => event.session_id + ':ask:' + event.ask_id
export function speechKey(event: IrisEvent): string | null {
  if (event.type === 'speech') return event.ask_id && event.text?.trim() ? askKey(event) + ':' + event.seq : null
  if (!event.speak?.trim()) return null
  if (event.type === 'decision' && event.level === 'speak' && event.frame_id) return event.session_id + ':frame:' + event.frame_id
  if (event.type === 'answer' && event.ask_id) return askKey(event)
  return null
}
