import { expect, test, type Page } from '@playwright/test'
import type { Task, TaskIssueSnapshot } from '../../src/shared/types'

const start = new Date('2026-09-11T12:00:00Z').getTime()

async function publish(page: Page, taskId: string, patch: Partial<Task>, phase?: 'working' | 'reviewing' | 'complete') {
  const snapshot: TaskIssueSnapshot | null = phase ? {
    parent: { id: 'parent', title: 'Elapsed time plan', description: '' },
    children: [{
      id: 'child', parentId: 'parent', title: 'Measure working time', description: '',
      status: phase === 'reviewing' ? 'review' : phase === 'complete' ? 'complete' : 'working',
      checklist: [], validation: '', labels: [], priority: 'medium', dependencies: []
    }],
    execution: { phase, currentIssueId: phase === 'complete' ? null : 'child', error: null },
    reviewReady: true
  } : null
  await page.evaluate(async ({ taskId, patch, snapshot }) => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === taskId)!
    window.dispatchEvent(new CustomEvent('fixture:issues', { detail: { taskId, snapshot } }))
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, ...patch } }))
  }, { taskId, patch, snapshot })
}

const elapsed = (page: Page) => page.getByRole('group', { name: 'Task statistics' })
  .locator('div').filter({ has: page.getByText('Elapsed', { exact: true }) })

test('elapsed counts working intervals across intermediate review, resume and final review', async ({ page }, testInfo) => {
  await page.clock.install({ time: start })
  await page.clock.pauseAt(start)
  await page.goto('/tests/e2e/fixture/?scenario=output&steering')
  await publish(page, 'output', {
    status: 'running', deliveryStatus: 'working', endedAt: undefined,
    workingTimeMs: 20000, workingStartedAt: start
  }, 'working')
  await expect(elapsed(page)).toHaveText('Elapsed20s')
  await page.clock.runFor(5000)
  await expect(elapsed(page)).toHaveText('Elapsed25s')
  await page.screenshot({ path: testInfo.outputPath('working.png') })

  // Intermediate review deliberately retains raw running/working status.
  await publish(page, 'output', { workingTimeMs: 25000, workingStartedAt: undefined }, 'reviewing')
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Review: Measure working time')
  await page.clock.fastForward(3600000)
  await expect(elapsed(page)).toHaveText('Elapsed25s')
  await page.screenshot({ path: testInfo.outputPath('intermediate-review.png') })

  await page.getByRole('button', { name: 'Open task: Build streaming support', exact: true }).click()
  await page.clock.fastForward(60000)
  await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
  await expect(elapsed(page)).toHaveText('Elapsed25s')

  // A delayed resume snapshot must refresh immediately, before the next timer tick.
  const resumedAt = await page.evaluate(() => Date.now() - 4000)
  await publish(page, 'output', { workingTimeMs: 25000, workingStartedAt: resumedAt }, 'working')
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Working')
  await expect(elapsed(page)).toHaveText('Elapsed29s')
  await page.clock.runFor(3000)
  await expect(elapsed(page)).toHaveText('Elapsed32s')
  await page.screenshot({ path: testInfo.outputPath('resumed-working.png') })

  await publish(page, 'output', {
    status: 'succeeded', deliveryStatus: 'reviewable', endedAt: resumedAt + 7000,
    workingTimeMs: 32000, workingStartedAt: undefined
  }, 'complete')
  await page.clock.fastForward(7200000)
  await expect(elapsed(page)).toHaveText('Elapsed32s')
  await page.screenshot({ path: testInfo.outputPath('final-review.png') })
  await page.getByRole('button', { name: 'Open task: Build streaming support', exact: true }).click()
  await page.clock.fastForward(60000)
  await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
  await expect(elapsed(page)).toHaveText('Elapsed32s')

  for (const stage of ['working', 'intermediate-review', 'resumed-working', 'final-review']) {
    await testInfo.attach(stage, { path: testInfo.outputPath(`${stage}.png`), contentType: 'image/png' })
  }
})

test('switching active tasks refreshes the clock even with identical interval starts', async ({ page }) => {
  await page.clock.install({ time: start })
  await page.clock.pauseAt(start)
  await page.goto('/tests/e2e/fixture/?scenario=output')
  await publish(page, 'output', { status: 'running', deliveryStatus: 'working', workingTimeMs: 10000, workingStartedAt: start })
  await publish(page, 'running', { workingTimeMs: 40000, workingStartedAt: start })
  await expect(elapsed(page)).toHaveText('Elapsed10s')
  // Move wall time without firing timers, so navigation must refresh the clock itself.
  await page.clock.setSystemTime(start + 5000)
  await page.getByRole('button', { name: 'Open task: Build streaming support', exact: true }).click()
  await expect(elapsed(page)).toHaveText('Elapsed45s')
  await page.clock.setSystemTime(start + 9000)
  await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
  await expect(elapsed(page)).toHaveText('Elapsed19s')
  await page.clock.runFor(1000)
  await expect(elapsed(page)).toHaveText('Elapsed20s')
})
