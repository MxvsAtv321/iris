import { expect, test } from '@playwright/test'
test('garden link carries the active judge session', async ({ page }) => {
  // The session is chosen on the phone page; the dashboard only watches.
  await page.goto('/phone')
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByLabel('SESSION', { exact: true }).fill('judge 02')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('link', { name: /Memory garden/ })).toHaveAttribute('href', '/garden?session=judge%2002')
})
test('real garden loads without a session and does not download depth models', async ({ page }) => {
  const errors: string[] = []
  const depthRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/huggingface.co|\/src\/garden\/depth.ts/.test(request.url())) depthRequests.push(request.url()) })
  await page.goto('/garden')
  await expect(page.locator('.garden h1')).toHaveText('Memory garden', { timeout: 20000 })
  await expect(page.getByText('This page needs a session.', { exact: false })).toBeVisible()
  expect(errors).toEqual([])
  expect(depthRequests).toEqual([])
})
