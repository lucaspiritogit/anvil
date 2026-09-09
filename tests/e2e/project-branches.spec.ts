import { expect, test } from '@playwright/test'
import { chooseBranch, restoreComposerSelection } from './composer-setup'

test.beforeEach(async ({ page }) => restoreComposerSelection(page))

test('project branch floats above the composer and switches local branches', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  const branch = page.getByRole('button', { name: 'Project branch', exact: true })
  const composer = page.getByRole('form', { name: 'Start a task' })
  await expect(branch).toHaveAccessibleDescription('main')
  await branch.click()
  await expect(page.getByRole('dialog', { name: 'Choose branch' }).getByRole('button', { name: 'task-running', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(branch).toBeFocused()
  const branchBounds = (await branch.boundingBox())!
  expect(branchBounds.y + branchBounds.height).toBeLessThan((await composer.boundingBox())!.y)
  await composer.getByRole('textbox').fill('Keep my draft')
  await chooseBranch(branch, 'feature/composer')
  await expect(branch).toHaveAccessibleDescription('feature/composer')
  expect((await page.evaluate(() => window.anvil.projects.branches('project-0'))).currentBranch).toBe('feature/composer')
  await expect(composer.getByRole('textbox')).toHaveValue('Keep my draft')
  await page.screenshot({ path: testInfo.outputPath('project-branch.png'), fullPage: true })
  await page.setViewportSize({ width: 600, height: 600 })
  await expect(branch).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('project-branch-compact.png'), fullPage: true })
})

test('checkout errors retain the branch and a pending checkout blocks task submission', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  const branch = page.getByRole('button', { name: 'Project branch', exact: true })
  const composer = page.getByRole('form', { name: 'Start a task' })
  await expect(branch).toHaveAccessibleDescription('main')
  await page.evaluate(() => {
    window.anvil.projects.checkout = async () => {
      await new Promise<void>((resolve) => window.addEventListener('fixture:checkout-ready', () => resolve(), { once: true }))
      throw new Error('Your local changes would be overwritten by checkout')
    }
  })
  await composer.getByRole('textbox').fill('Wait for the branch')
  await chooseBranch(branch, 'feature/composer')
  await expect(branch).toBeDisabled()
  await expect(branch).toBeFocused()
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await composer.getByRole('textbox').press('Control+Enter')
  expect(await page.evaluate(async () => (await window.anvil.tasks.list()).filter((task) => task.id.startsWith('started-')))).toHaveLength(0)
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:checkout-ready')))
  await expect(page.getByRole('alert')).toContainText('local changes would be overwritten')
  await expect(branch).toHaveAccessibleDescription('main')
  await expect(branch).toBeEnabled()
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})

test('branch keyboard navigation skips in-use branches and exposes long project and branch names', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  const longBranch = 'feature/a-very-long-branch-name-that-should-truncate-without-hiding-the-project-name'
  const longProject = 'A very long project name that remains next to the branch'
  await page.evaluate(async ({ longBranch, longProject }) => {
    const projects = await window.anvil.projects.list()
    for (const project of projects) await window.anvil.projects.update({ id: project.id, name: longProject })
    window.anvil.projects.branches = async () => ({ currentBranch: longBranch, branches: [
      { name: longBranch, checkedOut: true }, { name: 'in-use', checkedOut: true }, { name: 'main', checkedOut: false }
    ] })
  }, { longBranch, longProject })
  // Refresh the overview branch picker so the mocked project and branches are loaded.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const composer = page.getByTestId('project-overview')
  const branch = composer.getByRole('button', { name: 'Project branch', exact: true })
  await expect(branch).toHaveAccessibleDescription(longBranch)
  const project = composer.getByTestId('composer-project-name')
  await expect(project).toHaveText(longProject)
  await expect(project).toHaveAttribute('title', longProject)
  const projectBounds = (await project.boundingBox())!
  expect(projectBounds.x + projectBounds.width).toBeLessThan((await branch.boundingBox())!.x)
  await branch.click()
  const picker = page.getByRole('dialog', { name: 'Choose branch' })
  await expect(picker.getByRole('button', { name: longBranch, exact: true })).toHaveAttribute('aria-pressed', 'true')
  await picker.getByRole('searchbox').press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(picker.getByRole('button', { name: 'main', exact: true })).toBeFocused()
  await picker.getByRole('searchbox').fill('no-match')
  await expect(picker.getByRole('status')).toHaveText('No branches match your search.')
  await page.keyboard.press('Escape')
  for (const width of [1280, 600]) {
    await page.setViewportSize({ width, height: 600 })
    await expect(branch).toBeInViewport()
    await expect(project).toBeInViewport()
    expect(await composer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`branch-long-${width}.png`) })
  }
})

test('detached HEAD can choose a branch and non-Git projects retain their name', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(() => {
    window.anvil.projects.branches = async () => ({ currentBranch: null, branches: [{ name: 'main', checkedOut: false }] })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const composer = page.getByTestId('project-overview')
  const branch = composer.getByRole('button', { name: 'Project branch', exact: true })
  await expect(branch).toHaveAccessibleDescription('Detached HEAD')
  await branch.click()
  await expect(page.getByRole('dialog', { name: 'Choose branch' }).getByRole('button', { name: 'main', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.evaluate(() => { window.anvil.projects.gitStatus = async () => ({ isRepository: false }) })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(branch).toHaveCount(0)
  await expect(composer.getByTestId('composer-project-name')).toBeVisible()
})

test('switching projects ignores a late checkout result and releases submission for the new project', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(() => {
    window.anvil.projects.checkout = async () => {
      await new Promise<void>((resolve) => window.addEventListener('fixture:checkout-ready', () => resolve(), { once: true }))
      return { currentBranch: 'old-project-branch', branches: [{ name: 'old-project-branch', checkedOut: true }] }
    }
  })
  const branch = page.getByRole('button', { name: 'Project branch', exact: true })
  await chooseBranch(branch, 'feature/composer')
  await expect(branch).toBeDisabled()
  await page.getByRole('combobox', { name: 'Project', exact: true }).click()
  await page.getByRole('option').filter({ hasText: '/tmp/workbench' }).click()
  await expect(page.getByTestId('composer-project-name')).toHaveText('Workbench')
  await expect(branch).toHaveAccessibleDescription('main')
  await expect(branch).toBeEnabled()
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:checkout-ready')))
  const composer = page.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('textbox').fill('New project draft')
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expect(branch).toHaveAccessibleDescription('main')
})

test('branch loading and discovery errors recover on refresh', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(() => {
    window.anvil.projects.branches = async () => {
      await new Promise<void>((resolve) => window.addEventListener('fixture:branches-ready', () => resolve(), { once: true }))
      throw new Error('Repository is temporarily unavailable')
    }
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const composer = page.getByTestId('project-overview')
  const branch = composer.getByRole('button', { name: 'Project branch', exact: true })
  await expect(branch).toHaveAccessibleDescription('Loading branch…')
  await expect(branch).toBeDisabled()
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:branches-ready')))
  await expect(branch).toHaveAccessibleDescription('Branch unavailable')
  await expect(composer.getByRole('alert')).toHaveText('Repository is temporarily unavailable')
  await page.evaluate(() => {
    window.anvil.projects.branches = async () => ({ currentBranch: 'recovered', branches: [{ name: 'recovered', checkedOut: true }] })
    window.dispatchEvent(new Event('focus'))
  })
  await expect(branch).toHaveAccessibleDescription('recovered')
  await expect(branch).toBeEnabled()
  await expect(composer.getByRole('alert')).toHaveCount(0)
})
