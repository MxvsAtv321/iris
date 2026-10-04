// Judge sign-in with Neon Auth. A judge gives a name and gets an account of their own, so the memory the
// glasses save and the tree in the garden belong to them alone. The account's id is the session id.
//
// Everything here fails soft: if sign-in is not configured, slow or down, every function says so quietly
// and the app carries on with the no-login session. Nothing here throws to its caller except signIn,
// which the sign-in form reports.

// Sign-in is OFF unless it is switched on, so a demo has no login step at all. Two switches:
//   VITE_JUDGE_SIGN_IN=1 in the root .env   on for everyone (restart the web server)
//   /phone?signin=1                         on for this phone from now on, without a restart (?signin=0 turns it off)
// While it is off nothing here makes a request, and the app uses the no-login session.
const SWITCH = 'iris-sign-in'
export function signInEnabled(): boolean {
  try {
    const asked = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('signin')
    if (asked === '1') localStorage.setItem(SWITCH, '1')
    if (asked === '0') localStorage.removeItem(SWITCH)
    if (localStorage.getItem(SWITCH) === '1') return true
  } catch { /* no storage: only the build-time switch counts */ }
  return import.meta.env.VITE_JUDGE_SIGN_IN === '1'
}

const AUTH = '/auth'            // this site's own address; the web server passes it on to Neon Auth
const TIMEOUT_MS = 4000
const KEY = 'iris-judge'
export type Judge = { id: string; name: string; email: string; password: string }

export function savedJudge(): Judge | null {
  try {
    const judge: unknown = JSON.parse(localStorage.getItem(KEY) || 'null')
    const j = judge as Partial<Judge> | null
    return j && typeof j.id === 'string' && typeof j.name === 'string' && typeof j.email === 'string' && typeof j.password === 'string' ? j as Judge : null
  } catch { return null }
}

async function call(path: string, body?: unknown): Promise<Response> {
  return fetch(AUTH + path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

/** Whether sign-in can be offered at all. False when it is switched off, isn't configured, or the service doesn't answer. */
export async function signInAvailable(): Promise<boolean> {
  if (!signInEnabled()) return false
  try { return (await call('/ok')).ok } catch { return false }
}

const userId = async (response: Response): Promise<string | null> => {
  if (!response.ok) return null
  const body = await response.json().catch(() => null) as { user?: { id?: unknown } } | null
  return typeof body?.user?.id === 'string' ? body.user.id : null
}

/** Sign a judge in by name. The first time on a phone this makes their account; after that it signs the
 *  same account back in. Throws with a plain message when it can't. */
export async function signIn(name: string): Promise<Judge> {
  const clean = name.trim().slice(0, 60)
  if (!clean) throw new Error('Enter your name to sign in.')
  const saved = savedJudge()
  try {
    if (saved && saved.name === clean) {
      const id = await userId(await call('/sign-in/email', { email: saved.email, password: saved.password }))
      if (id) return remember({ ...saved, id })
    }
    // The address only has to be unique: nothing is ever sent to it.
    const fresh = { name: clean, email: `judge-${crypto.randomUUID()}@example.com`, password: crypto.randomUUID() + crypto.randomUUID() }
    const id = await userId(await call('/sign-up/email', fresh))
    if (!id) throw new Error('refused')
    return remember({ ...fresh, id })
  } catch {
    throw new Error('Sign-in isn’t available right now. Iris still works without it.')
  }
}

function remember(judge: Judge): Judge {
  try { localStorage.setItem(KEY, JSON.stringify(judge)) } catch { /* signed in for this page only */ }
  token = null
  return judge
}

export function signOut(): void {
  try { localStorage.removeItem(KEY) } catch { /* nothing saved */ }
  token = null
  void call('/sign-out', {}).catch(() => {})
}

let token: { value: string; session: string; expires: number } | null = null
let refreshing: Promise<string | null> | null = null

/** The signed-in judge's token for memory, or null. Only for their own session: a judge looking at any
 *  other session reads it the no-login way. Tokens last 15 minutes and are renewed a minute early. */
export async function tokenFor(sessionId: string): Promise<string | null> {
  const judge = savedJudge()
  if (!judge || judge.id !== sessionId || !signInEnabled()) return null
  if (token && token.session === sessionId && token.expires - Date.now() > 60_000) return token.value
  refreshing ??= (async () => {
    try {
      let response = await call('/token')
      if (response.status === 401) {   // the sign-in lapsed: sign the saved account back in, once
        if (!await userId(await call('/sign-in/email', { email: judge.email, password: judge.password }))) return null
        response = await call('/token')
      }
      const value = response.ok ? (await response.json() as { token?: unknown }).token : null
      if (typeof value !== 'string') return null
      const claims = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number; sub?: string }
      if (claims.sub !== sessionId) return null
      token = { value, session: sessionId, expires: (claims.exp ?? 0) * 1000 }
      return value
    } catch { return null } finally { refreshing = null }
  })()
  return refreshing
}

/** Called when memory refuses a token, so the next request fetches a new one. */
export function forgetToken(): void { token = null }
