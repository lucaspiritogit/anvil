import { expect, test } from '@playwright/test'

const fixture = '/tests/e2e/fixture/?scenario=review'

test('Open PR previews the remote, drafts editable fields, and shows created PR details', async ({ page }, testInfo) => {
  await page.goto(fixture)
  // Review actions live in the task header, so they are reachable from any panel.
  const open = page.getByRole('button', { name: 'Open PR', exact: true })
  const merge = page.getByRole('button', { name: 'Merge', exact: true })
  await expect(open).toBeEnabled()
  expect((await open.boundingBox())!.x).toBeLessThan((await merge.boundingBox())!.x)
  await open.click()
  const dialog = page.getByRole('dialog', { name: 'Open PR', exact: true })
  await expect(dialog).toContainText('developer/anvil via origin')
  await expect(dialog).toContainText('as developer')
  await expect(dialog).toContainText('3 commits will be proposed against the remote branch')
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Handwritten title')
  await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Handwritten description')
  await dialog.getByRole('button', { name: 'Generate PR title with Codex' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Codex is writing the title…')
  await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Improve sidebar review')
  await expect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Handwritten description')
  await dialog.getByRole('button', { name: 'Generate PR description with Codex' }).click()
  await expect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(/Improve sidebar spacing/)
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('My edited PR title')
  await page.screenshot({ path: testInfo.outputPath('open-pr.png') })
  await dialog.getByRole('button', { name: 'Open PR', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Opening PR…' })).toBeDisabled()
  await page.keyboard.press('Escape')
  const created = page.getByRole('dialog', { name: 'Pull request created' })
  await expect(created).toContainText('#42 My edited PR title')
  await expect(created).toContainText('anvil/review into main, opened by developer')
  await expect(created.getByRole('link')).toHaveAttribute('href', 'https://github.com/developer/anvil/pull/42')
  await page.screenshot({ path: testInfo.outputPath('created-pr.png') })
  await created.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Open PR')
  await expect(page.getByLabel('Task status', { exact: true })).not.toContainText('Ready to review')
  await expect(page.getByLabel('Task status', { exact: true }).getByText('Open PR', { exact: true })).toHaveCSS('color', 'rgb(124, 195, 121)')
  await expect(page.getByLabel('Task status', { exact: true }).locator('path')).toHaveAttribute('d', /M15 6C12\.6131/)
  const sidebarTask = page.getByRole('button', { name: 'Open task: Review sidebar changes', exact: true })
  await expect(sidebarTask.getByRole('img', { name: 'Open PR', exact: true })).toBeVisible()
  await expect(sidebarTask.getByRole('img', { name: 'Ready for review', exact: true })).toHaveCount(0)
  await expect(merge).toBeEnabled()
  await expect(open).toBeFocused()
})

test('cancelling the PR dialog does not push or merge', async ({ page }) => {
  await page.goto(fixture)
  await page.evaluate(() => {
    window.addEventListener('fixture:open-pr', () => { throw new Error('Unexpected PR creation') })
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('button', { name: 'Open PR', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeEnabled()
  expect(errors).toEqual([])
})

for (const [platform, modifier] of [['darwin', 'Meta'], ['linux', 'Control']] as const) {
  test(`${modifier}-click opens an existing PR without selecting its task on ${platform}`, async ({ page }) => {
    await page.goto(`${fixture}&openPr=1&platform=${platform}`)
    await page.evaluate(() => {
      const urls: string[] = []
      Object.assign(window, { openedPullRequestUrls: urls })
      window.anvil.github.openUrl = async (url) => { urls.push(url) }
    })
    const reviewTask = page.getByRole('button', { name: 'Open task: Review sidebar changes', exact: true })
    await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
    await reviewTask.dispatchEvent('click', modifier === 'Meta' ? { metaKey: true } : { ctrlKey: true })
    await expect(page.getByRole('heading', { name: 'Layout test task', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as unknown as { openedPullRequestUrls: string[] }).openedPullRequestUrls))
      .toEqual(['https://github.com/developer/anvil/pull/42'])
    await reviewTask.click()
    await expect(page.getByRole('heading', { name: 'Review sidebar changes', exact: true })).toBeVisible()
    await reviewTask.click({ button: 'right' })
    await expect(page.getByRole('menu', { name: 'Task actions', exact: true })).toBeVisible()
  })
}

for (const [query, message] of [
  ['prPreviewFailure', 'Add your GitHub token in Settings.'],
  ['prEmpty', 'There are no commits to propose against this remote branch.']
]) {
  test(`PR confirmation blocks submission for ${query}`, async ({ page }) => {
    await page.goto(`${fixture}&${query}=1`)
    await page.getByRole('tab', { name: /^Changes/ }).click()
    await page.getByRole('button', { name: 'Open PR', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(message)
    await expect(dialog.getByRole('button', { name: 'Open PR', exact: true })).toBeDisabled()
  })
}

test('PR and drafting failures preserve editable user text', async ({ page }) => {
  await page.goto(`${fixture}&prFailure=1&prDraftFailure=1`)
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('button', { name: 'Open PR', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const title = dialog.getByRole('textbox', { name: 'Title', exact: true })
  await title.fill('Keep my title')
  await dialog.getByRole('button', { name: 'Generate PR title with Codex' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('The agent could not draft PR text.')
  await expect(title).toHaveValue('Keep my title')
  await dialog.getByRole('button', { name: 'Open PR', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('branch was pushed')
  await expect(title).toHaveValue('Keep my title')
  await expect(title).toBeEditable()
})

test('GitHub settings saves, masks, and removes the token', async ({ page }, testInfo) => {
  await page.goto(fixture)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Source control', exact: true }).click()
  const github = page.getByRole('region', { name: 'GitHub integration' })
  const token = github.getByLabel('Personal access token')
  await expect(token).toHaveAttribute('type', 'password')
  await token.fill('test-personal-token')
  await github.getByRole('button', { name: 'Save token' }).click()
  await expect(github.getByRole('status')).toHaveText('Token saved')
  await expect(token).toHaveValue('')
  await github.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('github-settings.png') })
  await github.getByRole('button', { name: 'Remove token' }).click()
  await expect(github.getByRole('status')).toHaveText('No token saved')
})
