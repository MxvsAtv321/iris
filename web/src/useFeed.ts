import { useEffect, useState } from 'react'
import { parseEvent, type IrisEvent } from './api'
export function useFeed(session: string, demo: boolean) {
  const [events, setEvents] = useState<IrisEvent[]>([])
  const [status, setStatus] = useState('Connecting')
  useEffect(() => {
    let active = true
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout>
    let deadline: ReturnType<typeof setTimeout>
    let attempts = 0
    function append(event: IrisEvent) { if (active) setEvents(old => [event, ...old].slice(0, 200)) }
    if (demo) {
      const samples = [
        { level: 'silent', text: '', reason: 'Nothing new in view. Giving you space.' },
        { level: 'display', text: 'Check line 2', reason: 'A possible arithmetic error on the whiteboard.' },
        { level: 'silent', text: '', reason: 'This object was already described recently.' },
        { level: 'speak', text: 'Sample: 12g protein per bar', reason: 'A direct question deserves an answer.' },
      ] as const
      let index = 0
      const tick = () => append({ type: 'decision', session_id: session, at: new Date().toISOString(), ...samples[index++ % samples.length] })
      tick()
      const interval = setInterval(tick, 3500)
      return () => { active = false; clearInterval(interval) }
    }
    function connect() {
      if (!active) return
      setStatus(attempts ? 'Reconnecting' : 'Connecting')
      const ws = new WebSocket(new URL('/api/ws', location.origin.replace(/^http/, 'ws')))
      socket = ws
      deadline = setTimeout(() => ws.close(), 8000)
      ws.onopen = () => { clearTimeout(deadline); attempts = 0; if (active) setStatus('Connected') }
      ws.onmessage = message => {
        const event = parseEvent(String(message.data))
        if (event && event.session_id === session) append(event)
      }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        clearTimeout(deadline)
        if (active) {
          setStatus('Offline · retrying')
          retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000))
        }
      }
    }
    connect()
    return () => { active = false; clearTimeout(retry); clearTimeout(deadline); socket?.close() }
  }, [session, demo])
  return { events, status: demo ? 'Demo feed' : status }
}

