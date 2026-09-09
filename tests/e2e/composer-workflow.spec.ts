import { expect, test } from '@playwright/test'
import { chooseBranch, chooseProvider, restoreComposerSelection } from './composer-setup'
import { taskImages } from '../task-image-fixture'

for (const placement of ['overview', 'modal'] as const) {
  test(`${placement} submits the selected project, provider, model, image and path reference together`, async ({ page }, testInfo) => {
    await restoreComposerSelection(page)
    await page.goto('/tests/e2e/fixture/')
    const project = page.getByRole('combobox', { name: 'Project', exact: true })
    await project.fill('work')
    await page.getByRole('option').filter({ hasText: '/tmp/workbench' }).click()
    if (placement === 'modal') await page.getByRole('button', { name: 'New task', exact: true }).click()
    const surface = placement === 'modal' ? page.getByRole('dialog', { name: 'Start new task' }) : page.getByTestId('project-overview')
    const composer = surface.getByRole('form', { name: 'Start a task' })
    const prompt = composer.getByRole('textbox', { name: 'Task prompt' })
    const branch = surface.getByRole('button', { name: 'Project branch', exact: true })
    const projectName = surface.getByTestId('composer-project-name')
    await expect(projectName).toHaveText('Workbench')
    await chooseBranch(branch, 'feature/composer')
    await expect(branch).toHaveAccessibleDescription('feature/composer')
    const nameBox = (await projectName.boundingBox())!
    expect(nameBox.x + nameBox.width).toBeLessThanOrEqual((await branch.boundingBox())!.x)
    await chooseProvider(composer.getByRole('button', { name: /^(Choose a model|Model:)/ }), 'opencode')
    await composer.getByRole('button', { name: 'Model: model', exact: true }).click()
    await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: 'model', exact: true }).click()
    await prompt.fill('Inspect @Only')
    await expect(page.getByRole('option', { name: 'workbench/OnlyHere.ts', exact: true })).toBeVisible()
    await prompt.press('Enter')
    await prompt.press('Shift+Enter')
    await prompt.pressSequentially('Use this image')
    const [image] = await taskImages()
    await prompt.evaluate((element, image) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(image.bytes)], image.filename, { type: image.mimeType }))
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    }, { ...image, bytes: Array.from(image.bytes) })
    await expect(composer.getByRole('img')).toHaveCount(1)
    await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    for (const width of [1280, 600]) {
      await page.setViewportSize({ width, height: 800 })
      await expect(branch).toBeInViewport()
      await expect(prompt).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath(`workflow-${placement}-${width}.png`) })
    }
    const draft = await prompt.inputValue()
    await page.evaluate(() => { window.composerTest.failNextStart = true })
    await prompt.press('Enter')
    await expect(composer.getByRole('alert')).toHaveText('Task could not be started')
    await expect(prompt).toHaveValue(draft)
    await expect(composer.getByRole('img')).toHaveCount(1)
    await prompt.press('Enter')
    await expect.poll(() => page.evaluate(() => window.composerTest.starts.length)).toBe(2)
    const requests = await page.evaluate(() => window.composerTest.starts.map((input) => ({
      ...input, images: input.images?.map((image) => ({ ...image, bytes: Array.from(image.bytes) }))
    })))
    expect(requests).toEqual([0, 1].map(() => ({
      workspaceId: 'default', projectId: 'project-1', agentId: 'opencode', model: 'provider/model', prompt: draft.trim(),
      fileReferences: ['workbench/OnlyHere.ts'], images: [{ ...image, bytes: Array.from(image.bytes) }]
    })))
    expect(await page.evaluate(() => window.anvil.projects.branches('project-1'))).toMatchObject({ currentBranch: 'feature/composer' })
    expect(await page.evaluate(() => window.anvil.projects.branches('project-0'))).toMatchObject({ currentBranch: 'main' })
    await expect(composer).toHaveCount(0)
  })
}
