import { expect, test } from '@playwright/test'
test('iris compiles, draws in WebGL, and survives context loss', async ({ page }) => {
  await page.goto('/phone')
  const visual = page.locator('.iris-visual')
  await expect(visual).toHaveAttribute('data-renderer', 'webgl')
  await expect(visual.locator('canvas')).toHaveAttribute('data-quality', 'full')
  const error = await visual.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).getContext('webgl')!.getError())
  expect(error).toBe(0)
  await page.screenshot({ path: 'test-results/iris-desktop.png', fullPage: true })
  const extension = await visual.locator('canvas').evaluateHandle(canvas => (canvas as HTMLCanvasElement).getContext('webgl')!.getExtension('WEBGL_lose_context')!)
  await extension.evaluate(ext => ext.loseContext())
  await expect(visual).toHaveAttribute('data-renderer', 'css')
  await extension.evaluate(ext => ext.restoreContext())
  await expect(visual).toHaveAttribute('data-renderer', 'webgl')
})
test('iris uses a CSS fallback when WebGL is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (...args: Parameters<typeof original>) {
      if (String(args[0]).startsWith('webgl')) return null
      return original.apply(this, args)
    } as typeof original
  })
  await page.goto('/phone')
  await expect(page.locator('.iris-visual')).toHaveAttribute('data-renderer', 'css')
  await expect(page.getByRole('button', { name: 'Tap to talk' })).toBeEnabled()
})
test('iris steps down under a sustained sub-30fps clock', async ({ page }) => {
  await page.addInitScript(() => {
    window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 45)
    window.cancelAnimationFrame = handle => clearTimeout(handle)
  })
  await page.goto('/phone')
  await expect(page.locator('canvas.iris-canvas')).toHaveAttribute('data-quality', 'simple', { timeout: 7000 })
  await expect(page.locator('.iris-visual')).toHaveAttribute('data-renderer', 'css', { timeout: 7000 })
})
test('iris shows thinking while waiting for the brain on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/ask', async route => {
    await new Promise(resolve => setTimeout(resolve, 1000))
    await route.fulfill({ json: { display: 'A bar', speak: '', level: 'display', latency_ms: 1000 } })
  })
  await page.goto('/phone')
  await page.getByLabel('OR TYPE A QUESTION').fill('What is this?')
  await page.getByRole('button', { name: 'Send question' }).click()
  await expect(page.locator('.iris-visual')).toHaveAttribute('data-state', 'thinking')
  await page.screenshot({ path: 'test-results/iris-mobile.png', fullPage: true })
  await expect(page.locator('.iris-visual')).toHaveAttribute('data-state', 'idle')
})
