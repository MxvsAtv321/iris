export type Level = 'silent' | 'display' | 'speak'
export type Answer = { display: string; speak: string; level: Level; latency_ms: number }
export type IrisEvent = {
  type: 'decision' | 'answer' | 'metrics' | 'memory_saved'; session_id: string; at: string;
  level?: Level; text?: string; reason?: string; frame_id?: string; question?: string;
  display?: string; speak?: string; latency_ms?: number; answer_latency_ms_p50?: number;
  gate_precision?: number; moment_id?: string; description?: string;
}
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
      case 'metrics': if (!finite(v.answer_latency_ms_p50) || !finite(v.gate_precision) || v.gate_precision > 1) return null; break
      case 'memory_saved': if (typeof v.moment_id !== 'string' || typeof v.description !== 'string') return null; break
      default: return null
    }
    return v as IrisEvent
  } catch { return null }
}
export async function ask(session_id: string, text: string, signal: AbortSignal): Promise<Answer> {
  const response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id, text }), signal })
  if (!response.ok) throw new Error(response.status >= 500 ? 'The brain is unavailable. Check that FastAPI is running.' : 'The brain could not accept this question. Try again.')
  const answer: unknown = await response.json()
  if (!isAnswer(answer)) throw new Error('The brain returned an unexpected answer format.')
  return answer
}
export function stripWakeWord(text: string): string | null {
  const match = text.trim().match(/^(?:hey\s+)?(?:iris|iriss|eyeris|irish|aries)\b[\s,.!?;:]*/i)
  return match ? text.trim().slice(match[0].length).trim() : null
}
