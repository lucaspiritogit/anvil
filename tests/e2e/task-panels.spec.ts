import { expect, test } from '@playwright/test'

for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 500 }]) {
  for (const scenario of ['output', 'review']) {
    test(`task opens Output with Changes available at ${viewport.width}px, ${scenario}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      await page.goto(`/tests/e2e/fixture/?scenario=${scenario}`)
      const outputTab = page.getByRole('tab', { name: 'Output', exact: true })
      const changesTab = page.getByRole('tab', { name: /^Changes/ })
      await expect(outputTab).toBeVisible()
      await expect(outputTab).toHaveAttribute('aria-selected', 'true')
      await expect(changesTab).toBeVisible()
      await expect(changesTab).toBeEnabled()
      if (scenario === 'output') await expect(changesTab).toHaveText('Changes 0')
      await expect(page.getByRole('log', { name: 'Task output' })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Code changes' })).toBeHidden()
      await page.screenshot({ path: testInfo.outputPath('default-output.png') })
      await changesTab.click()
      await expect(changesTab).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('region', { name: 'Code changes' })).toBeVisible()
      if (scenario === 'review') {
        await expect(page.getByRole('combobox', { name: 'Changed file' })).toBeVisible()
      } else {
        await expect(page.getByText('There is no final diff available for review.')).toBeVisible()
      }
      await outputTab.click()
      await expect(page.getByRole('log', { name: 'Task output' })).toBeVisible()
    })
  }
}

test('switching to another task resets the active tab to Output', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('button', { name: /Build streaming support/ }).click()
  await expect(page.getByRole('tab', { name: 'Output', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('log', { name: 'Task output' })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^Changes/ })).toBeEnabled()
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByText('The final task diff will appear here when it is ready for review.')).toBeVisible()
})

const children = (['queued', 'working', 'blocked', 'complete'] as const).map((status) => ({
  id: status, parentId: 'parent', title: `Child ${status}`, description: `Description for ${status}`,
  status, checklist: [], validation: '', labels: [], priority: 'medium' as const, dependencies: []
}))

const STATUS_LABEL = { queued: 'Queued', working: 'Working', blocked: 'Blocked', complete: 'Finished' } as const

test('shared child view isolates status, history and controls and recovers from deletion', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 500 })
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate((children) => {
    window.dispatchEvent(new CustomEvent('fixture:issues', { detail: {
      taskId: 'review', snapshot: { parent: { id: 'parent', title: 'Parent', description: '' }, children }
    } }))
    const read = window.anvil.tasks.events
    window.anvil.tasks.events = async (id) => [...await read(id), ...['working', 'blocked', 'complete'].map((issueId) => ({
      id: issueId, issueId, taskId: id, ts: 1, stream: 'stdout' as const, kind: 'output' as const,
      category: 'message' as const, text: `Saved ${issueId} result`
    }))]
  }, children)
  await page.getByRole('button', { name: 'Expand subtasks: Review sidebar changes', exact: true }).click()
  for (const status of ['queued', 'working', 'blocked', 'complete']) {
    await page.getByRole('button', { name: `Open subtask: Child ${status}`, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Child ${status}`)
    await expect(page.getByLabel('Valence status')).toHaveText(STATUS_LABEL[status])
    await expect(page.getByRole('region', { name: 'Task prompt' })).toContainText(`Description for ${status}`)
    await expect(page.getByRole('region', { name: 'Task prompt' })).not.toContainText('Keyboard shortcuts')
    await expect(page.getByRole('group', { name: 'Task statistics' })).toHaveCount(0)
    // Sub-task views expose their own Changes panel; only finished children have a diff.
    await page.getByRole('tab', { name: 'Changes', exact: true }).click()
    if (status === 'complete') {
      await expect(page.getByRole('region', { name: 'Subtask code changes' }).getByRole('combobox', { name: 'Changed file' })).toBeVisible()
    } else {
      await expect(page.getByText('Its diff will appear here when the sub-task is submitted for review.')).toBeVisible()
    }
    await page.getByRole('tab', { name: 'Output', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await expect(page.getByRole('log')).not.toContainText('Keyboard shortcuts')
    if (status === 'queued') await expect(page.getByRole('log')).toContainText('Execution has not started')
    else await expect(page.getByRole('log')).toContainText(`Saved ${status} result`)
    await expect(page.getByLabel('Agent activity')).toHaveCount(status === 'working' ? 1 : 0)
  }
  await page.screenshot({ path: testInfo.outputPath('child-view.png') })
  await page.evaluate((children) => {
    children[3].status = 'queued'
    window.dispatchEvent(new CustomEvent('fixture:issues', { detail: {
      taskId: 'review', snapshot: { parent: { id: 'parent', title: 'Parent', description: '' }, children }
    } }))
  }, children)
  await expect(page.getByRole('log')).toContainText('Queued again')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:issues', { detail: {
    taskId: 'review', snapshot: null
  } })))
  await expect(page.getByText('This subtask is no longer available in this task.')).toBeVisible()
  await expect(page.getByRole('log')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open owning task' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review sidebar changes')
  await expect(page.getByRole('tab', { name: /^Changes/ })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('parent-view.png') })
})

test('rapid sibling and parent switches discard delayed reads and restore Output', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  const setup = async () => page.evaluate((children) => {
    window.dispatchEvent(new CustomEvent('fixture:issues', { detail: {
      taskId: 'review', snapshot: { parent: { id: 'parent', title: 'Parent', description: '' }, children }
    } }))
    window.anvil.tasks.events = async (taskId) => {
      await new Promise((resolve) => setTimeout(resolve, 700))
      return ['working', 'blocked'].map((issueId) => ({
        id: issueId, issueId, taskId, ts: 1, stream: 'stdout' as const, kind: 'output' as const,
        category: 'message' as const, text: `History ${issueId}`
      }))
    }
  }, children)
  await setup()
  await page.getByRole('button', { name: 'Expand subtasks: Review sidebar changes', exact: true }).click()
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('button', { name: 'Open subtask: Child working', exact: true }).click()
  await page.getByRole('button', { name: 'Open subtask: Child blocked', exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:output', { detail: {
    id: 'live', taskId: 'review', issueId: 'blocked', ts: 2, stream: 'stdout', kind: 'output',
    category: 'message', text: 'Live blocked'
  } })))
  await expect(page.getByRole('log')).toContainText('Live blocked')
  await expect(page.getByRole('log')).toContainText('History blocked')
  await expect(page.getByRole('log')).toContainText('Live blocked')
  await expect(page.getByRole('log')).not.toContainText('History working')
  await page.getByRole('button', { name: 'Open owning task' }).click()
  await expect(page.getByRole('tab', { name: 'Output', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await setup()
  await page.getByRole('button', { name: 'Expand subtasks: Review sidebar changes', exact: true }).click()
  await page.getByRole('button', { name: 'Open subtask: Child working', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('History working')
  await expect(page.getByRole('log')).not.toContainText('History blocked')
})

test('foreign children never expose output and failed child reads can retry', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate((children) => {
    window.dispatchEvent(new CustomEvent('fixture:issues', { detail: {
      taskId: 'review', snapshot: { parent: { id: 'parent', title: 'Parent', description: '' },
        children: children.map((child) => ({ ...child, parentId: 'foreign-parent' })) }
    } }))
  }, children)
  await page.getByRole('button', { name: 'Expand subtasks: Review sidebar changes', exact: true }).click()
  await page.getByRole('button', { name: 'Open subtask: Child queued', exact: true }).click()
  await expect(page.getByText('This subtask is no longer available in this task.')).toBeVisible()
  await expect(page.getByRole('log')).toHaveCount(0)
  await page.evaluate((children) => {
    window.anvil.tasks.events = async () => { throw new Error('Output unavailable') }
    window.dispatchEvent(new CustomEvent('fixture:issues', { detail: {
      taskId: 'review', snapshot: { parent: { id: 'parent', title: 'Parent', description: '' }, children }
    } }))
  }, children)
  await expect(page.getByRole('alert')).toContainText('Output unavailable')
  await expect(page.getByText('Queued. Execution has not started.')).toHaveCount(0)
  await page.evaluate(() => { window.anvil.tasks.events = async () => [] })
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Execution has not started')
})
