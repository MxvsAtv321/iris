import { expect, test, type WebSocketRoute } from '@playwright/test'

test('session startup, changes, and offline failure', async ({ page }) => {
  const sessions: string[] = []
  await page.route('**/api/session', route => {
    const id = route.request().postDataJSON().session_id
    sessions.push(id)
    return route.fulfill({ status: id === 'next-judge' ? 503 : 200, json: {} })
  })
  await page.routeWebSocket('**/api/ws', () => {})
  await page.goto('/phone')
  await expect.poll(() => sessions.includes('judge-01')).toBe(true)
  await expect(page.getByText('LIVE', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByLabel('SESSION', { exact: true }).fill('next-judge')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect.poll(() => sessions.includes('next-judge')).toBe(true)
  await page.getByRole('button', { name: 'Close menu' }).click()
  await expect(page.getByText('OFFLINE', { exact: true })).toBeVisible()
})

test('HTTP answer stays silent; WebSocket speech is deduplicated and falls back to text', async ({ page }) => {
  let socket: WebSocketRoute
  const tts: string[] = []
  await page.route('**/api/session', route => route.fulfill({ json: {} }))
  await page.routeWebSocket('**/api/ws', ws => { socket = ws })
  await page.route('**/api/tts?*', route => {
    tts.push(new URL(route.request().url()).searchParams.get('text')!)
    return route.fulfill({ status: 204 })
  })
  await page.route('**/api/ask', route => route.fulfill({ json: {
    display: 'HTTP answer', speak: 'Do not play this', level: 'speak', latency_ms: 12,
  } }))
  await page.goto('/phone')
  await page.getByLabel('OR TYPE A QUESTION').fill('Question')
  await page.getByRole('button', { name: 'Send question' }).click()
  await expect(page.getByText('HTTP answer', { exact: true })).toBeVisible()
  expect(tts).toEqual([])
  const event = { type: 'answer', session_id: 'judge-01', at: new Date().toISOString(),
    ask_id: 'browser-answer', question: 'Question', display: 'WS answer', speak: 'WebSocket speech', latency_ms: 12 }
  socket!.send(JSON.stringify(event))
  socket!.send(JSON.stringify(event))
  await expect(page.getByText('Voice unavailable. Iris’s words are shown on screen.')).toBeVisible()
  expect(tts).toEqual(['WebSocket speech'])
  await expect(page.getByText('WebSocket speech', { exact: true })).toBeVisible()
})

test('dashboard renders null precision and measurement basis', async ({ page }) => {
  let socket: WebSocketRoute
  await page.route('**/api/session', route => route.fulfill({ json: {} }))
  await page.routeWebSocket('**/api/ws', ws => { socket = ws })
  await page.goto('/dashboard')
  await expect.poll(() => !!socket).toBe(true)
  const event = { type: 'metrics', session_id: 'judge-01', at: new Date().toISOString(),
    gate_precision: null as number | null, answer_latency_ms_p50: null, gate_precision_basis: null as string | null }
  socket!.send(JSON.stringify(event))
  await expect(page.getByText('not measured yet', { exact: true })).toBeVisible()
  socket!.send(JSON.stringify({ ...event, gate_precision: 0.9, gate_precision_basis: 'measured on 10 test photos' }))
  await expect(page.getByText('measured on 10 test photos', { exact: true })).toBeVisible()
  await expect(page.getByText('90%', { exact: true })).toBeVisible()
})
