import { expect, test } from '@playwright/test'
import { chooseBranch, chooseProject, restoreComposerSelection } from './composer-setup'

test.beforeEach(async ({ page }) => restoreComposerSelection(page))

test('project trash action confirms removal and leaves the checkout on disk', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  const trash = page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'Delete Workbench', exact: true })
  await expect(trash.locator('svg')).toBeVisible()
  await trash.click()
  const dialog = page.getByRole('dialog', { name: 'Delete project?' })
  await expect(dialog).toContainText('The project checkout on disk will not be deleted.')
  await dialog.getByRole('button', { name: 'Delete project', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.anvil.projects.list()).map((project) => project.name))).not.toContain('Workbench')
})

test('Quick defaults to the current checkout and supports keyboard branch switching', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  const surface = page.getByTestId('project-overview')
  const project = surface.getByRole('button', { name: 'Project', exact: true })
  const location = surface.getByLabel('Execution location', { exact: true })
  const branch = surface.getByRole('button', { name: 'Project branch', exact: true })
  const composer = surface.getByRole('form', { name: 'Start a task' })

  await expect(composer.getByRole('combobox', { name: 'Task style' })).toHaveValue('quick')
  await expect(project).toHaveAccessibleDescription('Anvil, /tmp/anvil')
  await expect(location).toHaveText(/Current checkout/)
  await expect(branch).toHaveAccessibleDescription('main')
  for (const control of [project, branch]) {
    await expect(control).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(control).toHaveAttribute('aria-expanded', 'false')
    await expect(control.locator('svg').last()).toHaveAttribute('width', '12')
  }

  await project.focus()
  await project.press('Enter')
  await expect(project).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('dialog', { name: 'Choose project' }).getByRole('searchbox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(project).toBeFocused()
  await expect(location).not.toHaveAttribute('aria-haspopup')
  await branch.press('Enter')
  await expect(branch).toHaveAttribute('aria-expanded', 'true')
  const picker = page.getByRole('dialog', { name: 'Choose local branch' })
  await expect(picker.getByRole('button', { name: 'task-running', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(branch).toBeFocused()

  const branchBounds = (await branch.boundingBox())!
  expect(branchBounds.y + branchBounds.height).toBeLessThan((await composer.boundingBox())!.y)
  await composer.getByRole('textbox').fill('Keep my draft')
  await chooseBranch(branch, 'feature/composer')
  await expect(branch).toHaveAccessibleDescription('feature/composer')
  expect((await page.evaluate(() => window.anvil.projects.branches('project-0'))).currentBranch).toBe('feature/composer')
  await expect(composer.getByRole('textbox')).toHaveValue('Keep my draft')

  for (const width of [1280, 600]) {
    await page.setViewportSize({ width, height: 600 })
    for (const control of [project, location, branch]) await expect(control).toBeInViewport()
    expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`checkout-controls-${width}.png`) })
  }
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
  expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:checkout-ready')))
  await expect(page.getByRole('alert')).toContainText('local changes would be overwritten')
  await expect(branch).toHaveAccessibleDescription('main')
  await expect(branch).toBeEnabled()
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})

test('branch keyboard navigation skips in-use branches and truncates long labels', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  const longBranch = 'feature/a-very-long-branch-name-that-should-truncate-without-hiding-the-project-name'
  const longProject = 'A very long project name that remains next to the branch'
  await page.evaluate(async ({ longBranch, longProject }) => {
    const projects = await window.anvil.projects.list()
    for (const project of projects) await window.anvil.projects.update({ id: project.id, name: longProject })
    window.anvil.projects.branches = async () => ({ currentBranch: longBranch, branches: [
      { name: longBranch, checkedOut: true }, { name: 'in-use', checkedOut: true }, { name: 'main', checkedOut: false }
    ], worktreeBases: [{ name: 'origin/main', ref: 'refs/remotes/origin/main', remote: true }],
    defaultWorktreeBase: { name: 'origin/main', ref: 'refs/remotes/origin/main', remote: true } })
  }, { longBranch, longProject })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const surface = page.getByTestId('project-overview')
  const branch = surface.getByRole('button', { name: 'Project branch', exact: true })
  const project = surface.getByRole('button', { name: 'Project', exact: true })
  await expect(branch).toHaveAccessibleDescription(longBranch)
  await expect(project).toHaveAccessibleDescription(`${longProject}, /tmp/anvil`)
  await expect(surface.getByTestId('composer-project-name')).toHaveText(longProject)
  await branch.click()
  const picker = page.getByRole('dialog', { name: 'Choose local branch' })
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
    expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`branch-long-${width}.png`) })
  }
})

test('detached HEAD stays explicit and non-Git projects explain that Work is unavailable', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(() => {
    window.anvil.projects.branches = async () => ({ currentBranch: null, branches: [{ name: 'main', checkedOut: false }], worktreeBases: [], defaultWorktreeBase: null })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const surface = page.getByTestId('project-overview')
  const branch = surface.getByRole('button', { name: 'Project branch', exact: true })
  await expect(branch).toHaveAccessibleDescription('Detached HEAD')
  await branch.click()
  await expect(page.getByRole('dialog', { name: 'Choose local branch' }).getByRole('button', { name: 'main', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.evaluate(() => { window.anvil.projects.gitStatus = async () => ({ isRepository: false }) })
  await chooseProject(surface.getByRole('button', { name: 'Project', exact: true }), 'workbench', 'Workbench')
  await expect(surface.getByTestId('composer-project-name')).toHaveText('Workbench')
  await expect(branch).toHaveAccessibleDescription('No Git branch')
  await expect(branch).toBeDisabled()
  const composer = surface.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('combobox', { name: 'Task style' }).selectOption('work')
  await expect(surface.getByRole('alert')).toHaveText(/Work requires a Git repository/)
  await composer.getByRole('textbox').fill('Try isolated work')
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
})

test('switching projects ignores a late checkout result and releases submission for the new project', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(() => {
    window.anvil.projects.checkout = async () => {
      await new Promise<void>((resolve) => window.addEventListener('fixture:checkout-ready', () => resolve(), { once: true }))
      return { currentBranch: 'old-project-branch', branches: [{ name: 'old-project-branch', checkedOut: true }], worktreeBases: [], defaultWorktreeBase: null }
    }
  })
  const branch = page.getByRole('button', { name: 'Project branch', exact: true })
  await chooseBranch(branch, 'feature/composer')
  await expect(branch).toBeDisabled()
  await page.evaluate(() => window.composerTest.selectProject('project-1'))
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
  const surface = page.getByTestId('project-overview')
  const branch = surface.getByRole('button', { name: 'Project branch', exact: true })
  await expect(branch).toHaveAccessibleDescription('Loading branch…')
  await expect(branch).toBeDisabled()
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:branches-ready')))
  await expect(branch).toHaveAccessibleDescription('Branch unavailable')
  await expect(surface.getByRole('alert')).toHaveText('Repository is temporarily unavailable')
  await page.evaluate(() => {
    window.anvil.projects.branches = async () => ({ currentBranch: 'recovered', branches: [{ name: 'recovered', checkedOut: true }], worktreeBases: [], defaultWorktreeBase: null })
    window.dispatchEvent(new Event('focus'))
  })
  await expect(branch).toHaveAccessibleDescription('recovered')
  await expect(branch).toBeEnabled()
  await expect(surface.getByRole('alert')).toHaveCount(0)
})

test('project picker browses server folders, clones repositories and retains the draft when adding fails', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  const composer = page.getByRole('form', { name: 'Start a task' })
  const prompt = composer.getByRole('textbox')
  const project = page.getByRole('button', { name: 'Project', exact: true })
  await prompt.fill('Keep this project draft')
  await page.evaluate(() => {
    const add = window.anvil.projects.add
    window.addEventListener('fixture:restore-add', () => { window.anvil.projects.add = add }, { once: true })
    window.anvil.projects.add = async () => { throw new Error('Folder picker unavailable') }
  })
  await project.click()
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'Add project', exact: true }).click()
  const addProject = page.getByRole('dialog', { name: 'Add project' })
  await expect(addProject.getByRole('textbox', { name: 'Server folder path' })).toHaveValue('/srv/projects')
  await addProject.getByRole('button', { name: 'Add this folder' }).click()
  await expect(addProject.getByRole('alert')).toHaveText('Folder picker unavailable')
  await expect(prompt).toHaveValue('Keep this project draft')
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:restore-add')))
  await addProject.getByRole('button', { name: 'treq' }).click()
  await expect(addProject.getByRole('textbox', { name: 'Server folder path' })).toHaveValue('/srv/projects/treq')
  await addProject.getByRole('button', { name: 'Add this folder' }).click()
  await expect(project).toHaveAccessibleDescription('treq, /srv/projects/treq')
  await expect(project).toBeFocused()

  await project.click()
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'Add project', exact: true }).click()
  const cloneProject = page.getByRole('dialog', { name: 'Add project' })
  await cloneProject.getByRole('button', { name: 'Clone Git repository' }).click()
  await cloneProject.getByRole('textbox', { name: 'HTTPS repository URL' }).fill('https://github.com/acme/remote-app.git')
  await cloneProject.getByRole('button', { name: 'Clone repository', exact: true }).click()
  await expect(project).toHaveAccessibleDescription('remote-app, /fixture/workspaces/default/projects/remote-app')
})

test('new worktrees use the selected base without switching the local checkout', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  const project = page.getByRole('button', { name: 'Project', exact: true })
  await chooseProject(project, 'workbench', 'Workbench')
  const composer = page.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('combobox', { name: 'Task style' }).selectOption('work')
  await expect(composer.getByRole('combobox', { name: 'Review policy' }).locator('option')).toHaveText(['Review each step', 'Review at the end'])
  const location = page.getByLabel('Execution location', { exact: true })
  await expect(location).toHaveText(/Isolated worktree/)

  const branch = page.getByRole('button', { name: 'Project branch', exact: true })
  await expect(branch).toHaveAccessibleDescription('starting from origin/main')
  const prompt = composer.getByRole('textbox', { name: 'Task prompt' })
  await prompt.fill('Use an isolated checkout')
  await page.evaluate(() => { window.composerTest.failNextStart = true })
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.composerTest.starts[0])).toEqual({
    workspaceId: 'default', projectId: 'project-1', style: 'work', reviewPolicy: 'review_each_issue',
    startBase: 'refs/remotes/origin/main', agentId: 'codex', model: 'gpt-5',
    prompt: 'Use an isolated checkout', parentTaskId: undefined, reasoningEffort: 'high'
  })
  await expect(composer.getByRole('alert')).toHaveText('Task could not be started')
  await expect(prompt).toHaveValue('Use an isolated checkout')
  await branch.click()
  await page.getByRole('dialog', { name: 'Choose worktree base' })
    .getByRole('button', { name: 'main', exact: true }).click()
  await expect(branch).toHaveAccessibleDescription('starting from main')
  expect((await page.evaluate(() => window.anvil.projects.branches('project-1'))).currentBranch).toBe('main')

  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.composerTest.starts[1])).toEqual({
    workspaceId: 'default', projectId: 'project-1', style: 'work', reviewPolicy: 'review_each_issue',
    startBase: 'refs/heads/main', agentId: 'codex', model: 'gpt-5',
    prompt: 'Use an isolated checkout', parentTaskId: undefined, reasoningEffort: 'high'
  })
  await expect.poll(async () => (await page.evaluate(() => window.anvil.tasks.list())).find((task) => task.id.startsWith('started-')))
    .toMatchObject({ checkoutMode: 'worktree', startBase: 'refs/heads/main', branchName: expect.stringMatching(/^anvil\//), baseBranch: 'main', cwd: expect.stringMatching(/^\/tmp\/anvil-worktrees\//) })
  expect((await page.evaluate(() => window.anvil.projects.branches('project-1'))).currentBranch).toBe('main')
})
