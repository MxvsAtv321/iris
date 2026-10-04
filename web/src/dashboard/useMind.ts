import { useEffect, useReducer, useRef, useState } from 'react'
import { parseEvent, type IrisEvent } from '../api'
import { EMPTY, parseSnapshot, reduce, type Snapshot } from './mind'

async function fetchSnapshot(): Promise<Snapshot | null> {
  try {
    const response = await fetch('/api/trace', { signal: AbortSignal.timeout(4000) })
    return response.ok ? parseSnapshot(await response.json()) : null
  } catch { return null }
}

const QUIET_MS = 30000   // the loop reports every 2 s; this long without a word means the session may have stopped

/** The brain's mind, read-only. It loads what has happened so far, then follows the WebSocket.
 *  Nothing here starts, stops or changes a session, so opening or reloading the dashboard changes nothing. */
export function useMind() {
  const [mind, dispatch] = useReducer(reduce, EMPTY)
  const [connected, setConnected] = useState(false)
  const latest = useRef(mind)
  useEffect(() => { latest.current = mind }, [mind])
  useEffect(() => {
    let active = true
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout>
    let deadline: ReturnType<typeof setTimeout>
    let attempts = 0
    let since: IrisEvent[] | null = null   // events that arrive while the snapshot loads
    let loadedAt = 0
    async function load() {
      if (since) return
      since = []
      loadedAt = Date.now()
      const snapshot = await fetchSnapshot()
      if (active && snapshot) dispatch({ type: 'snapshot', snapshot, since })
      since = null
    }
    function connect() {
      if (!active) return
      const ws = new WebSocket(new URL('/api/ws', location.origin.replace(/^http/, 'ws')))
      socket = ws
      deadline = setTimeout(() => ws.close(), 8000)
      ws.onopen = () => { clearTimeout(deadline); attempts = 0; if (active) { setConnected(true); void load() } }
      ws.onmessage = message => {
        const event = parseEvent(String(message.data))
        if (!event || !active) return
        since?.push(event)
        dispatch({ type: 'event', event })
      }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        clearTimeout(deadline)
        if (!active) return
        setConnected(false)
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000))
      }
    }
    connect()
    // Ask again when the first load failed, or when a running session has gone quiet (it may have been stopped).
    const check = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN || Date.now() - loadedAt < 15000) return
      const { loaded, running, events } = latest.current
      const last = events.at(-1)
      if (!loaded || (running && (!last || Date.now() - Date.parse(last.at) > QUIET_MS))) void load()
    }, 5000)
    return () => { active = false; clearTimeout(retry); clearTimeout(deadline); clearInterval(check); socket?.close() }
  }, [])
  return { mind, connected }
}
