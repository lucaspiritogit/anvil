import { expect, test } from '@playwright/test'

for (const viewport of [{ width: 1100, height: 700 }, { width: 900, height: 500 }, { width: 1400, height: 900 }]) {
  test(`output fits its container and scrolls at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/tests/e2e/fixture/?scenario=output')
    const output = page.getByRole('log', { name: 'Task output' })
    const latest = output.getByText(/^Output 299:/)
    await expect(latest).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeInViewport()
    const bounds = await output.boundingBox()
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(bounds!.height).toBeGreaterThan(100)

    await output.hover()
    await page.mouse.wheel(0, -100000)
    const first = output.getByText(/^Output 0:/)
    await expect(first).toBeInViewport()
    await first.click() // Expanded long output must also stay contained.
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeInViewport()
    const textBounds = await first.boundingBox()
    expect(textBounds!.x + textBounds!.width).toBeLessThanOrEqual(viewport.width)
    await page.getByRole('button', { name: 'Jump to latest' }).click()
    await expect(latest).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeInViewport()
  })
}

test('a long task description leaves room for output and navigation', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 })
  await page.goto('/tests/e2e/fixture/?scenario=output&longPrompt=1')
  await expect(page.getByRole('log')).toBeVisible()
  const bounds = await page.getByRole('log').boundingBox()
  expect(bounds!.height).toBeGreaterThan(100)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(500)
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeInViewport()
})
