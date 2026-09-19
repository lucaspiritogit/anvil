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
        await expect(page.getByText(/No code changes to review\.|There is no final diff available for review\./)).toBeVisible()
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

test('quick tasks keep the Changes panel available', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output')
  await page.evaluate(async () => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    useStore.setState((state) => ({
      tasks: state.tasks.map((task) => task.id === 'output' ? { ...task, style: 'quick' } : task)
    }))
  })

  await expect(page.getByRole('tab', { name: 'Output', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^Changes/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Issues', exact: true })).toHaveCount(0)

  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('region', { name: 'Code changes' })).toBeVisible()
})

test('completed quick tasks can commit their scoped changes or commit and push', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    useStore.setState((state) => ({
      tasks: state.tasks.map((task) => task.id === 'review'
        ? { ...task, style: 'quick', checkoutMode: 'local', reviewPaths: ['src/sidebar.ts', 'README.md'] }
        : task)
    }))
  })

  await expect(page.getByRole('button', { name: 'Open PR', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Merge task', exact: true })).toHaveCount(0)
  await page.evaluate(() => {
    window.addEventListener('fixture:quick-commit', (event) => {
      Object.assign(window, { lastQuickCommit: (event as CustomEvent).detail })
    })
  })
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'More commit actions' }).click()
  await page.getByRole('menuitem', { name: 'Commit & Push' }).click()
  const dialog = page.getByRole('dialog', { name: 'Commit & Push', exact: true })
  const message = dialog.getByRole('textbox', { name: 'Commit message', exact: true })
  await expect(message).toHaveValue('Review sidebar changes')
  await dialog.getByRole('button', { name: 'Generate commit message with Codex' }).click()
  await expect(message).toHaveValue('fix: clamp output rows by measured truncation')
  await message.fill('test: scoped quick commit')
  await dialog.getByRole('button', { name: 'Commit & Push', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { lastQuickCommit: unknown }).lastQuickCommit)).toEqual({ taskId: 'review', push: true, message: 'test: scoped quick commit' })
  await expect(page.getByRole('button', { name: 'Push', exact: true })).toHaveCount(0)
  await expect(page.getByText('Pushed', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('combobox', { name: 'Changed file' })).toHaveValue('src/sidebar.ts')
})

test('committed quick tasks push their head commit and hide the push action', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    useStore.setState((state) => ({
      tasks: state.tasks.map((task) => task.id === 'review'
        ? { ...task, style: 'quick', checkoutMode: 'local', deliveryStatus: 'approved', headCommit: 'quick-head', reviewPaths: ['src/sidebar.ts'] }
        : task)
    }))
    window.addEventListener('fixture:push', (event) => {
      Object.assign(window, { lastQuickPush: (event as CustomEvent).detail })
    })
  })

  await page.getByRole('tab', { name: 'Output', exact: true }).click()
  await page.getByRole('button', { name: 'Push', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Push', exact: true })).toHaveCount(0)
  await expect(page.getByText('Pushed', { exact: true })).toBeVisible()
  const detail = await page.evaluate(() => (window as unknown as { lastQuickPush: { taskId: string; preview: { targetBranch: string } } }).lastQuickPush)
  expect(detail.taskId).toBe('review')
  expect(detail.preview.targetBranch).toBe('user-current')
})

test('quick commit modal drafts fail without losing the typed message', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review&commitDraftFailure=1')
  await page.evaluate(async () => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    useStore.setState((state) => ({
      tasks: state.tasks.map((task) => task.id === 'review'
        ? { ...task, style: 'quick', checkoutMode: 'local', reviewPaths: ['src/sidebar.ts'] }
        : task)
    }))
  })
  await page.getByRole('button', { name: 'Commit', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Commit task changes', exact: true })
  const message = dialog.getByRole('textbox', { name: 'Commit message', exact: true })
  await message.fill('Keep my message')
  await dialog.getByRole('button', { name: 'Generate commit message with Codex' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('The agent could not draft a commit message.')
  await expect(message).toHaveValue('Keep my message')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeEnabled()
})

test('long task titles truncate to one line and the composer persists across panels', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 500 })
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1')
  const longTitle = 'A very long task title that must never wrap one letter per line'.repeat(4)
  await page.evaluate(async (title) => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    useStore.setState((state) => ({
      tasks: state.tasks.map((task) => task.id === 'output' ? { ...task, title } : task)
    }))
  }, longTitle)
  const heading = page.getByRole('heading', { level: 1 })
  await expect(heading).toHaveText(longTitle)
  await expect(heading).toHaveAttribute('title', longTitle)
  const headingBox = (await heading.boundingBox())!
  // One line at 16px/leading-snug is ~22px; two lines would exceed 40px.
  expect(headingBox.height).toBeLessThan(40)
  const metrics = await heading.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
  const composer = page.getByRole('form', { name: 'Steer task' })
  await expect(composer).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('long-title-output.png') })
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('region', { name: 'Code changes' })).toBeVisible()
  await expect(composer).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('long-title-changes.png') })
})

test('mobile header keeps review actions and every task panel usable without overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 })
  await page.goto('/tests/e2e/fixture/?scenario=review')
  const longTitle = 'Review a narrow layout with an exceptionally long title '.repeat(5)
  await page.evaluate(async (title) => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    useStore.setState((state) => ({
      tasks: state.tasks.map((task) => task.id === 'review' ? {
        ...task,
        title,
        model: `vendor/${'long-model-name-'.repeat(8)}`,
        branchName: `anvil/${'long-responsive-branch-'.repeat(8)}`
      } : task)
    }))
  }, longTitle)

  const main = page.getByRole('main')
  const heading = main.getByRole('heading', { level: 1 })
  await expect(heading).toHaveText(longTitle)
  expect((await heading.boundingBox())!.height).toBeLessThan(40)
  await expect(main.getByLabel('Task status')).toBeVisible()
  await expect(main.getByRole('button', { name: 'Open PR', exact: true })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Merge task', exact: true })).toBeVisible()

  for (const name of ['Output', 'Changes', 'Issues']) {
    await expect(main.getByRole('tab', { name: new RegExp(`^${name}`) })).toBeVisible()
  }
  await main.getByRole('tab', { name: /^Changes/ }).click()
  await expect(main.getByRole('region', { name: 'Code changes' })).toBeVisible()
  await main.getByRole('tab', { name: 'Issues', exact: true }).click()
  await expect(main.getByRole('tabpanel', { name: 'Issues' })).toBeVisible()

  await main.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(main.getByRole('button', { name: 'Copy branch name' })).toBeVisible()
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    main: document.querySelector('main')!.scrollWidth - document.querySelector('main')!.clientWidth
  }))
  expect(overflow.document).toBeLessThanOrEqual(1)
  expect(overflow.main).toBeLessThanOrEqual(1)

  await main.getByRole('button', { name: 'Open PR', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Open PR' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.screenshot({ path: testInfo.outputPath('mobile-review-header.png') })
})

test('stale child selection renders its owner with continuous output', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    const read = window.anvil.tasks.eventsPage
    window.anvil.tasks.eventsPage = async (input) => {
      const page = await read(input)
      const events = [...page.events, ...['working', 'blocked'].map((issueId) => ({
        id: issueId, issueId, taskId: input.taskId, sequence: issueId === 'working' ? 3 : 4, ts: 1, stream: 'stdout' as const, kind: 'output' as const,
        category: 'message' as const, text: `Saved ${issueId} result`
      }))]
      return { ...page, events, newestCursor: { taskId: input.taskId, sequence: 4 } }
    }
    useStore.getState().showHome()
    useStore.setState({ view: { kind: 'task', taskId: 'review', issueId: 'removed-child' }, eventsByTask: {} })
  })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review sidebar changes')
  await expect(page.getByRole('log')).toContainText('Saved working result')
  await expect(page.getByRole('log')).toContainText('Saved blocked result')
  await expect(page.getByRole('button', { name: 'Open task: Review sidebar changes', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('tab', { name: 'Issues', exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:output', { detail: {
    id: 'live', taskId: 'review', issueId: 'blocked', sequence: 5, ts: 2, stream: 'stdout', kind: 'output',
    category: 'message', text: 'Live blocked'
  } })))
  await expect(page.getByRole('log')).toContainText('Live blocked')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('combobox', { name: 'Changed file' })).toBeVisible()
})
