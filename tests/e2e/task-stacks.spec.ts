import { expect, test } from '@playwright/test'
import { restoreComposerSelection } from './composer-setup'

test('composer submits the selected stack parent', async ({ page }) => {
  await restoreComposerSelection(page)
  await page.goto('/tests/e2e/fixture/')
  await page.getByRole('combobox', { name: 'Stack on task' }).selectOption('running')
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Build the next part')
  await page.getByRole('textbox', { name: 'Task prompt' }).press('Control+Enter')
  await expect.poll(() => page.evaluate(() => window.composerTest.starts[0]?.parentTaskId)).toBe('running')
})

test('suggestion accepts stacking and links the parent in the view and sidebar', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, stackSuggestion: { parentTaskId: 'running', paths: ['src/main/store.ts'] } } }))
  })
  await expect(page.getByText('This task expects to modify files')).toBeVisible()
  await page.getByRole('button', { name: 'Stack', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stacked on Build streaming support', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('stacked-task.png'), fullPage: true })
  await page.getByRole('button', { name: 'Stacked on Build streaming support', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Build streaming support', exact: true })).toBeVisible()
})

test('dismisses overlap suggestions and displays a restack conflict', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, stackSuggestion: { parentTaskId: 'running', paths: ['source.ts'] } } }))
  })
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(page.getByText('This task expects to modify files')).toHaveCount(0)
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, restackState: 'conflict', deliveryError: 'Resolve the conflict in source.ts.' } }))
  })
  await expect(page.getByRole('button', { name: 'Resolve with agent' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Retry restack' })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('restack-conflict.png'), fullPage: true })
})


test('merge preview explains child restacking and pending children cannot approve', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const child = (await window.anvil.tasks.list()).find((task) => task.id === 'running')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...child, parentTaskId: 'review' } }))
  })
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Merge and approve?' })
  await expect(dialog).toContainText('This will restack 1 stacked task.')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, restackState: 'pending' } }))
  })
  await expect(page.getByText('Restack pending. Changes will apply after the current turn.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled()
})
