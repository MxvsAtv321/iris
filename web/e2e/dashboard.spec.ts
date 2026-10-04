import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'

// A scripted session: one ordinary moment, one where Iris spoke, a question, and one a rule held back.
const BOARD = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#e9e9e4"/>
<g font-family="Helvetica, Arial, sans-serif" font-size="60" fill="#1c1c1c"><text x="80" y="130">Times tables</text><text x="80" y="260">7 x 8 = 54</text><text x="80" y="380">6 x 7 = 42</text><text x="80" y="500">9 x 9 = 81</text></g></svg>`
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()
const rules = (blocked?: string) => [
  { rule: 'cooldown', outcome: blocked === 'cooldown' ? 'blocked' : 'passed', detail: blocked === 'cooldown' ? "nudged about 'whiteboard-math' 20 s ago; one per 120 s" : "no nudge about 'whiteboard-math' in the last 120 s" },
  { rule: 'repeat', outcome: blocked ? 'blocked' : 'passed', similarity: blocked ? 0.86 : 0, threshold: 0.6, detail: blocked ? "already said 'Line 2 says seven times eight is fifty-four. It is fifty-six.'" : 'not said in the last 5 minutes' },
  { rule: 'quiet_after_answer', outcome: 'passed', detail: 'no question in the last 10 s' },
  { rule: 'rate_limit', outcome: 'passed', detail: 'nothing spoken in the last 15 s' },
]
let frames = 0
function decision(seconds: number, level: string, trace: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const frame_id = `f_${String(++frames).padStart(4, '0')}`
  return { type: 'decision', session_id: 'judge-01', at: ago(seconds), level, text: '', speak: '', reason: 'no change', frame_id, focus_box: [0.08, 0.33, 0.5, 0.15],
    ...extra, trace: { frame_url: `/api/frame/${frame_id}?v=test`, looked: false, skipped: 'no_change', change: { score: 2.1, threshold: 12 }, saw: '', why: '', topic: '', model: null,
      candidate: { text: '', say: '' }, urgency: null, display_at: 5, speak_at: 8, proposed: 'silent', rules: [], blocked_by: null, verdict: level, latency_ms: { capture: 160, total: 164 }, ...trace } }
}
const quiet = (from: number, to: number) => Array.from({ length: Math.floor((from - to) / 2) }, (_, i) => decision(from - i * 2, 'silent'))
const board = { looked: true, skipped: null, saw: 'A whiteboard of times tables. Line 2 reads 7 x 8 = 54.', why: 'Arithmetic error on line 2.', topic: 'whiteboard-math', model: 'openai:gpt-6-luna', urgency: 9, proposed: 'speak',
  candidate: { text: 'Line 2: 7x8 is 56', say: 'Line 2 says seven times eight is fifty-four. It is fifty-six.' } }
function session() {
  frames = 0
  return [
    decision(150, 'silent', { looked: true, skipped: null, saw: 'A desk with a laptop and a mug.', why: 'Nothing here needs attention.', topic: 'desk', model: 'openai:gpt-6-luna', urgency: 1, rules: rules().map(r => ({ ...r, outcome: 'not_checked', detail: '' })), latency_ms: { capture: 158, model: 1900, gate: 0.01, total: 2060 } }),
    ...quiet(148, 62),
    decision(60, 'speak', { ...board, rules: rules(), latency_ms: { capture: 171, model: 2380, gate: 0.05, total: 2553 } }, { text: 'Line 2: 7x8 is 56', speak: board.candidate.say, reason: 'urgency 9: Arithmetic error on line 2.' }),
    ...quiet(58, 46),
    { type: 'answer', session_id: 'judge-01', at: ago(45), ask_id: 'a_0001', question: 'what should line 2 say?', display: '7 x 8 = 56', speak: 'Seven times eight is fifty-six.', latency_ms: 1720, first_word_ms: 640, context: [] },
    ...quiet(44, 42),
    decision(40, 'silent', { ...board, rules: rules('cooldown'), blocked_by: 'cooldown', latency_ms: { capture: 164, model: 2210, gate: 0.04, total: 2376 } }, { reason: "cooldown on 'whiteboard-math'" }),
    ...quiet(38, 2),
  ]
}
const metrics = { answer_latency_ms_p50: 1720, answer_latency_ms_p95: 1720, first_word_ms_p50: 640, gate_precision: 1, gate_precision_basis: 'measured on 10 test photos', gate_accuracy: 0.9,
  moments_seen: 75, moments_silent: 74, moments_shown: 0, moments_spoken: 1, watch_model: 'openai:gpt-6-luna' }

async function brain(page: Page, snapshot: unknown) {
  const calls: string[] = []
  let socket: WebSocketRoute | undefined
  page.on('request', request => { if (request.url().includes('/api/session')) calls.push(request.method()) })
  await page.route('**/api/trace', route => route.fulfill({ json: snapshot }))
  await page.route('**/api/frame**', route => route.fulfill({ contentType: 'image/svg+xml', body: BOARD }))
  await page.routeWebSocket('**/api/ws', ws => { socket = ws })
  return { calls, send: async (event: unknown) => { await expect.poll(() => !!socket).toBe(true); socket!.send(JSON.stringify(event)) } }
}
test.use({ viewport: { width: 1440, height: 900 } })

test('dashboard never starts or restarts a session, and a reload shows the same session', async ({ page }) => {
  const { calls } = await brain(page, { session_id: 'judge-01', events: session(), metrics })
  await page.goto('/dashboard')
  await expect(page.getByText('session judge-01')).toBeVisible()
  await expect(page.locator('.mind-numbers')).toContainText('75')
  await page.reload()
  await expect(page.locator('.mind-numbers')).toContainText('75')
  await expect(page.getByRole('status')).toHaveText('Live')
  expect(calls).toEqual([])
})

test('a held-back moment reads as saw, considered, decided, with the rule named', async ({ page }) => {
  await brain(page, { session_id: 'judge-01', events: session(), metrics })
  await page.goto('/dashboard')
  const moment = page.locator('.mind-moment[data-expanded=true]')
  await expect(moment.getByText('A whiteboard of times tables. Line 2 reads 7 x 8 = 54.')).toBeVisible()
  await expect(moment.getByRole('img', { name: 'Urgency 9 of 10. Iris shows a line at 5 and speaks at 8.' })).toBeVisible()
  await expect(moment.locator('.mind-rules li')).toHaveText([/Cooldown\s*blocked: nudged about 'whiteboard-math' 20 s ago/, /Repeat\s*blocked, similarity 0.86 of 0.6/, /Quiet after an answer\s*passed/, /Rate limit\s*passed/])
  await expect(moment.locator('.mind-decided')).toContainText("Stayed silent. Cooldown: nudged about 'whiteboard-math' 20 s ago; one per 120 s.")
  await expect(moment.locator('.mind-decided')).toContainText('It had this ready: Line 2 says seven times eight is fifty-four. It is fifty-six.')
  await expect(moment.locator('.mind-latency')).toHaveText('Capture 164 ms, model 2.2 s, gate 0.04 ms, with gpt-6-luna')
  // the moment it did speak, the question it answered, and the measured numbers
  await expect(page.locator('.mind-moment[data-level=speak]').first()).toContainText('Seven times eight is fifty-six.')
  await expect(page.locator('.mind-numbers')).toContainText('1.7 s')
  await expect(page.locator('.mind-numbers')).toContainText('90%')
  await expect(page.locator('.mind-numbers')).toContainText('measured on 10 test photos')
  await expect(page.locator('.mind-timeline .tl-speak')).toHaveCount(1)
  await expect(page.locator('.mind-timeline .tl-held')).toHaveCount(1)
  await expect(page.getByText('held back', { exact: false }).last()).toBeVisible()
  await expect(page.locator('.mind-frame')).toHaveAttribute('data-looking', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true)
  await page.screenshot({ path: 'test-results/dashboard-held-back.png', animations: 'disabled' })
})

test('a spoken moment arrives over the socket, and the timeline goes back to it', async ({ page }) => {
  const { send } = await brain(page, { session_id: 'judge-01', events: session().slice(0, 1), metrics: { ...metrics, moments_seen: 1, moments_silent: 1, moments_spoken: 0 } })
  await page.goto('/dashboard')
  await expect(page.getByText('A desk with a laptop and a mug.')).toBeVisible()
  const spoke = decision(0, 'speak', { ...board, rules: rules() }, { text: 'Line 2: 7x8 is 56', speak: board.candidate.say })
  await send(spoke)
  await send(spoke)   // the same frame twice is still one moment
  await send({ ...decision(0, 'speak', board), session_id: 'someone-else', type: 'answer_delta', ask_id: 'a_1' })
  const moment = page.locator('.mind-moment[data-expanded=true]')
  await expect(moment.locator('.mind-decided')).toContainText('Spoke.Line 2 says seven times eight is fifty-four. It is fifty-six.')
  await expect(page.locator('.mind-numbers')).toContainText('Spoke 1 time, showed 0 lines.')
  await expect(page.locator('.mind-timeline .tl-speak')).toHaveCount(1)
  // the next capture arrives at once, but the frame Iris spoke about stays up for a few seconds
  await send(decision(0, 'silent', { skipped: 'model_spacing' }, { reason: 'scene changed; next model call in 6s' }))
  await expect(page.getByText('The scene moved.', { exact: false })).toBeVisible()
  await expect(page.getByText('Spoke about this')).toBeVisible()
  await expect(page.locator('.mind-frame')).toHaveAttribute('data-level', 'speak')
  await page.screenshot({ path: 'test-results/dashboard-spoke.png', animations: 'disabled' })
  await page.locator('.mind-moment').last().getByRole('button').click()
  await expect(page.getByText('Looking back at')).toBeVisible()
  await page.getByRole('button', { name: 'Back to now' }).click()
  await expect(page.getByText('Looking back at')).toHaveCount(0)
  await expect(page.getByText('Seeing now')).toBeVisible({ timeout: 12000 })
})

test('when the model itself declines to repeat a line, the dashboard says so as plainly as a rule', async ({ page }) => {
  const earlier = session().slice(0, 45)   // up to and including the moment it spoke
  const again = decision(0, 'silent', { ...board, why: 'The incorrect multiplication was already reported.', urgency: 0, proposed: 'silent', candidate: { text: '', say: '' },
    said_before: board.candidate.say, rules: rules().map(r => ({ ...r, outcome: 'not_checked', detail: '' })), latency_ms: { capture: 150, model: 2100, gate: 0.01, total: 2260 } },
    { reason: 'urgency 0: The incorrect multiplication was already reported.' })
  expect(earlier.at(-1)).toMatchObject({ level: 'speak' })
  await brain(page, { session_id: 'judge-01', events: [...earlier, again], metrics })
  await page.goto('/dashboard')
  const moment = page.locator('.mind-moment[data-expanded=true]')
  await expect(moment).toHaveAttribute('data-blocked', 'true')
  await expect(moment.locator('.mind-rules li')).toHaveText([/Already said\s*the model chose silence itself, before any rule was needed/])
  await expect(moment.locator('.mind-decided')).toContainText('Stayed silent. Already said: Iris chose not to repeat itself.')
  await expect(moment.locator('.mind-decided')).toContainText('What it said earlier: Line 2 says seven times eight is fifty-four. It is fifty-six.')
  await expect(page.locator('.mind-timeline .tl-held')).toHaveCount(1)
  await expect(page.locator('.mind-timeline .tl-speak')).toHaveCount(1)
  await page.screenshot({ path: 'test-results/dashboard-already-said.png', animations: 'disabled' })
})

test('dashboard stays calm with no session and with no brain', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await brain(page, { session_id: null, events: [], metrics: { ...metrics, gate_accuracy: null, gate_precision_basis: null, answer_latency_ms_p50: null } })
  await page.goto('/dashboard')
  await expect(page.getByText('No session is running. Start one from the phone. This screen only watches.')).toBeVisible()
  await expect(page.getByText('Gate accuracy. Not measured on test photos yet.')).toBeVisible()
  await page.unrouteAll()
  await page.route('**/api/trace', route => route.abort())
  await page.routeWebSocket('**/api/ws', ws => ws.close())
  await page.reload()
  await expect(page.getByRole('status')).toHaveText('Brain offline, retrying')
  await expect(page.getByText('Can’t reach the brain.', { exact: false })).toBeVisible()
  expect(errors).toEqual([])
})
