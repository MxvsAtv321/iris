import { expect, test } from '@playwright/test'
test('Figma phone assets load at their design sizes and settings stay usable', async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 })
  await page.goto('/phone')
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByLabel('Demo mode').check()
  await page.getByRole('button', { name: 'More options' }).click()
  await expect(page.getByText('Dark cacao almond bar', { exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const assets = await page.locator('.figma-phone img').evaluateAll(images => images.map(img => {
    const image = img as HTMLImageElement
    const rect = image.getBoundingClientRect()
    return { src: image.getAttribute('src'), loaded: image.complete && image.naturalWidth > 0, width: rect.width, height: rect.height }
  }))
  expect(assets.every(asset => asset.loaded)).toBe(true)
  for (const [name, width, height] of [['identity',86,86],['more',17,17],['scan',16,16],['live',19,19],['badge',12,12],['sparkles',12,12],['separator',3,3],['chevron',16,16],['wave',16,16],['mic',23,23],['product',112,112]] as const) {
    const asset = assets.find(a => a.src?.includes('/' + name + '.'))
    expect(asset, name).toBeDefined()
    expect(asset!.width, name).toBe(width)
    expect(asset!.height, name).toBe(height)
  }
  await page.screenshot({ path: 'test-results/figma-phone.png', fullPage: true })
  await page.getByRole('button', { name: /VISUAL MATCH/ }).click()
  await expect(page.getByText('This is the sample product', { exact: false })).toBeVisible()
})
