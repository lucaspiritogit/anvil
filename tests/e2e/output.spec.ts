import { expect, test } from '@playwright/test'
import type { TaskEvent } from '../../src/shared/types'

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

test('output is a compact event stream with event types on the left', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&tools=1')
  await expect(page.getByText('Agent conversation', { exact: true })).toHaveCount(0)
  const output = page.getByRole('log', { name: 'Task output' })
  const tool = output.locator('[data-output-category="tool_use"]')
  const typeBounds = (await tool.getByText('tool_use', { exact: true }).boundingBox())!
  const resultBounds = (await tool.getByText('Shell', { exact: true }).boundingBox())!
  expect(typeBounds.x + typeBounds.width).toBeLessThanOrEqual(resultBounds.x)
  expect(Math.abs(typeBounds.y - resultBounds.y)).toBeLessThan(3)
  await expect(output.locator('time')).toHaveCount(0)
  await expect(page.getByRole('form', { name: 'Steer task' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('event-stream.png') })
})

test('tool calls show a name and gray input, with one expandable result per call', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&tools=1')
  const output = page.getByRole('log', { name: 'Task output' })
  const tool = output.locator('[data-output-category="tool_use"]')
  const results = output.locator('[data-output-category="tool_result"]')
  await expect(tool).toHaveCount(1)
  await expect(tool.getByText('Shell', { exact: true })).toBeVisible()
  const command = tool.getByText('pwd && rg --files', { exact: true })
  await expect(command).toHaveClass(/text-dim/)
  const nameBounds = await tool.getByText('Shell', { exact: true }).boundingBox()
  const commandBounds = await command.boundingBox()
  expect(commandBounds!.y).toBeGreaterThan(nameBounds!.y)
  await expect(results).toHaveCount(1)
  await expect(results).toHaveAttribute('aria-expanded', 'false')
  const collapsedHeight = (await results.boundingBox())!.height
  await results.click()
  await expect(results).toHaveAttribute('aria-expanded', 'true')
  expect((await results.boundingBox())!.height).toBeGreaterThan(collapsedHeight)

  const emit = async (event: TaskEvent) => page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('fixture:output', { detail }))
  }, event)
  const result: TaskEvent = { id: 'tool-result:first', taskId: 'output', ts: 1, stream: 'stdout', kind: 'output', category: 'tool_result', text: '/tmp/project\nfirst.ts\nsecond.ts\nthird.ts' }
  await emit(result)
  await expect(results).toHaveCount(1)
  await expect(results).toContainText('third.ts')
  await expect(results).toHaveAttribute('aria-expanded', 'true')
  await emit({ ...result, id: 'tool-use:second', category: 'tool_use', text: 'Read file\npackage.json' })
  await emit({ ...result, id: 'tool-result:second', text: '{"name":"anvil"}' })
  await expect(tool).toHaveCount(2)
  await expect(results).toHaveCount(2)
  await emit({ ...result, category: 'error', stream: 'stderr', text: 'Command failed\nexit code 1' })
  await expect(output.locator('[data-output-category="error"]')).toHaveCount(1)
  await expect(results).toHaveCount(1)
  await expect(output.locator('[data-output-category]')).toHaveCount(4)
})

test('partial message and thinking snapshots update existing rows', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&tools=1')
  const output = page.getByRole('log', { name: 'Task output' })
  await expect(output.locator('[data-output-category="tool_result"]')).toHaveCount(1)
  for (const category of ['thinking', 'message'] as const) {
    const event: TaskEvent = {
      id: `partial-${category}`, taskId: 'output', ts: Date.now(), stream: 'stdout',
      kind: 'output', category, text: 'Partial text'
    }
    const emit = (detail: TaskEvent) => page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent('fixture:output', { detail }))
    }, detail)
    await emit(event)
    const row = output.locator(`[data-output-category="${category}"]`)
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Partial text')
    await emit({ ...event, text: 'Partial text continued without a newline' })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Partial text continued without a newline')
  }
})

test('a long task description leaves room for output and navigation', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 })
  await page.goto('/tests/e2e/fixture/?scenario=output&longPrompt=1')
  await expect(page.getByRole('log')).toBeVisible()
  const bounds = await page.getByRole('log').boundingBox()
  expect(bounds!.height).toBeGreaterThan(100)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(500)
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeInViewport()
})
