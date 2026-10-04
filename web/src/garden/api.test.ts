import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetToken } from '../judge'
import { listMoments } from './api'

const jwt = (sub: string) => 'h.' + btoa(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 900 })).replace(/=+$/, '') + '.s'
afterEach(() => { vi.unstubAllGlobals(); forgetToken() })

describe('the garden’s requests to memory', () => {
  function setup(judgeId: string | null, memory: (auth: string | null) => number) {
    const judge = judgeId && JSON.stringify({ id: judgeId, name: 'Maya', email: 'm@example.com', password: 'p' })
    vi.stubGlobal('localStorage', { getItem: () => judge, setItem: () => {}, removeItem: () => {} })
    const seen: (string | null)[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/token') return { ok: true, status: 200, json: async () => ({ token: jwt('user-1') }) }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null
      seen.push(auth)
      const status = memory(auth)
      return { ok: status < 400, status, json: async () => ({ moments: [] }) }
    }))
    return seen
  }
  it('carry the judge’s token for their own session, and no token for any other', async () => {
    const seen = setup('user-1', () => 200)
    await listMoments('user-1')
    await listMoments('judge-01')
    expect(seen).toEqual(['Bearer ' + jwt('user-1'), null])
  })
  it('are made again the no-login way when memory refuses the token', async () => {
    const seen = setup('user-1', auth => auth ? 401 : 200)
    expect(await listMoments('user-1')).toEqual([])
    expect(seen).toEqual(['Bearer ' + jwt('user-1'), null])
  })
  it('carry no token when nobody is signed in', async () => {
    const seen = setup(null, () => 200)
    await listMoments('judge-01')
    expect(seen).toEqual([null])
  })
})
