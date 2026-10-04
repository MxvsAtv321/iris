import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetToken, savedJudge, signIn, signInAvailable, signOut, tokenFor } from './judge'

const jwt = (sub: string, secondsLeft = 900) => 'h.' + btoa(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + secondsLeft })).replace(/=+$/, '') + '.s'
const reply = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: async () => body })
type Call = { path: string; body: Record<string, string> | null }
function auth(handler: (call: Call) => ReturnType<typeof reply>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call = { path: url.replace('/auth', ''), body: init?.body ? JSON.parse(String(init.body)) : null }
    calls.push(call)
    return handler(call)
  }))
  return calls
}
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
  forgetToken()
})
afterEach(() => vi.unstubAllGlobals())

describe('judge sign-in', () => {
  it('makes an account the first time and signs the same one back in after that', async () => {
    let calls = auth(call => call.path === '/sign-up/email' ? reply(200, { user: { id: 'user-1' } }) : reply(404))
    const judge = await signIn('  Maya ')
    expect(judge).toMatchObject({ id: 'user-1', name: 'Maya' })
    expect(calls.map(c => c.path)).toEqual(['/sign-up/email'])
    expect(calls[0].body).toMatchObject({ name: 'Maya', email: judge.email, password: judge.password })
    expect(savedJudge()).toEqual(judge)
    calls = auth(call => call.path === '/sign-in/email' ? reply(200, { user: { id: 'user-1' } }) : reply(404))
    expect((await signIn('Maya')).id).toBe('user-1')
    expect(calls).toEqual([{ path: '/sign-in/email', body: { email: judge.email, password: judge.password } }])
  })
  it('gives a different name its own account', async () => {
    auth(() => reply(200, { user: { id: 'user-1' } }))
    const maya = await signIn('Maya')
    const calls = auth(() => reply(200, { user: { id: 'user-2' } }))
    const sam = await signIn('Sam')
    expect(calls.map(c => c.path)).toEqual(['/sign-up/email'])
    expect([sam.id, sam.email === maya.email]).toEqual(['user-2', false])
  })
  it('says so plainly when sign-in is down, and leaves nothing half saved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    expect(await signInAvailable()).toBe(false)
    await expect(signIn('Maya')).rejects.toThrow('Sign-in isn’t available right now. Iris still works without it.')
    await expect(signIn('  ')).rejects.toThrow('Enter your name to sign in.')
    expect(savedJudge()).toBeNull()
    expect(await tokenFor('judge-01')).toBeNull()
  })
  it('refused sign-up is an error, not an account', async () => {
    auth(() => reply(422, { message: 'no' }))
    await expect(signIn('Maya')).rejects.toThrow('Sign-in isn’t available')
    expect(savedJudge()).toBeNull()
  })
})

describe('the judge’s token for memory', () => {
  it('is only for their own session, is reused, and is fetched again once memory refuses it', async () => {
    auth(() => reply(200, { user: { id: 'user-1' } }))
    await signIn('Maya')
    const calls = auth(call => call.path === '/token' ? reply(200, { token: jwt('user-1') }) : reply(404))
    expect(await tokenFor('judge-01')).toBeNull()            // someone else's session: read the no-login way
    expect(calls).toHaveLength(0)
    const first = await tokenFor('user-1')
    expect(first).toBe(await tokenFor('user-1'))
    expect(calls.map(c => c.path)).toEqual(['/token'])
    forgetToken()
    await tokenFor('user-1')
    expect(calls.map(c => c.path)).toEqual(['/token', '/token'])
  })
  it('signs the saved account back in when the sign-in has lapsed', async () => {
    auth(() => reply(200, { user: { id: 'user-1' } }))
    await signIn('Maya')
    let lapsed = true
    const calls = auth(call => {
      if (call.path === '/sign-in/email') { lapsed = false; return reply(200, { user: { id: 'user-1' } }) }
      return lapsed ? reply(401) : reply(200, { token: jwt('user-1') })
    })
    expect(await tokenFor('user-1')).toBe(jwt('user-1'))
    expect(calls.map(c => c.path)).toEqual(['/token', '/sign-in/email', '/token'])
  })
  it('is null, never an error, when the token is for someone else or sign-in is down', async () => {
    auth(() => reply(200, { user: { id: 'user-1' } }))
    await signIn('Maya')
    auth(() => reply(200, { token: jwt('someone-else') }))
    expect(await tokenFor('user-1')).toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    expect(await tokenFor('user-1')).toBeNull()
    signOut()
    expect(savedJudge()).toBeNull()
  })
})
