import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'

// Run after npm run build. Uses a temporary repository and application profile.
// --manual keeps the verified window open for native UI inspection until Enter.
const directory = await mkdtemp(join(tmpdir(), 'anvil-composer-pickers-'))
const projectName = 'A long project name for branch and provider picker verification'
const project = join(directory, projectName)
const longBranch = 'feature/a-long-branch-name-for-checking-truncation-in-the-task-composer'
const screenshots = resolve('test-results/composer-pickers-electron')
await mkdir(project)
await mkdir(screenshots, { recursive: true })
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim()
git('init', '-b', 'main')
await writeFile(join(project, 'example.txt'), 'main\n')
git('add', 'example.txt')
git('-c', 'user.name=Picker test', '-c', 'user.email=picker@example.invalid', 'commit', '-m', 'Initial fixture')
git('checkout', '-b', longBranch)
await writeFile(join(project, 'example.txt'), 'feature\n')
git('add', 'example.txt')
git('-c', 'user.name=Picker test', '-c', 'user.email=picker@example.invalid', 'commit', '-m', 'Feature fixture')
git('checkout', 'main')
const env = { ...process.env, ANVIL_DATA_DIR: join(directory, 'app-data'), ANVIL_MEMORY_BACKEND: 'disabled', SHELL: '/bin/bash' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let executablePath
if (process.argv.includes('--manual') && process.platform === 'darwin') {
  // Give the inspection window a unique application path when other Electron
  // development instances are already running on the same desktop.
  const bundle = join(directory, 'Picker Verification.app')
  await cp(resolve('node_modules/electron/dist/Electron.app'), bundle, { recursive: true, verbatimSymlinks: true })
  executablePath = join(bundle, 'Contents/MacOS/Electron')
  console.log(`Inspection app: ${bundle}`)
}
let application
try {
  application = await electron.launch({ executablePath, args: ['.'], env })
  application.context().setDefaultTimeout(15000)
  const page = await application.firstWindow()
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, project)
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  const branch = page.getByRole('button', { name: 'Project branch', exact: true })
  await expect(branch).toHaveAccessibleDescription('main')
  const chooseBranch = async (name) => {
    await branch.click()
    await page.getByRole('dialog', { name: 'Choose branch', exact: true }).getByRole('button', { name, exact: true }).click()
  }
  await chooseBranch(longBranch)
  await expect(branch).toHaveAccessibleDescription(longBranch)
  assert.equal(git('branch', '--show-current'), longBranch)
  await chooseBranch('main')
  await expect(branch).toHaveAccessibleDescription('main')
  await writeFile(join(project, 'example.txt'), 'uncommitted change\n')
  await chooseBranch(longBranch)
  await expect(page.getByRole('alert')).toContainText('would be overwritten')
  await expect(branch).toHaveAccessibleDescription('main')
  assert.equal(git('branch', '--show-current'), 'main')
  await writeFile(join(project, 'example.txt'), 'main\n')
  await chooseBranch(longBranch)
  await expect(branch).toHaveAccessibleDescription(longBranch)
  await expect(page.getByTestId('composer-project-name')).toHaveAttribute('title', projectName)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
  await page.screenshot({ path: join(screenshots, 'wide.png') })
  const provider = page.getByRole('button', { name: /^(Choose a model|Model:)/ })
  await provider.click()
  const picker = page.getByRole('dialog', { name: 'Choose model', exact: true })
  const search = picker.getByRole('searchbox')
  await expect(search).toBeFocused()
  await picker.getByRole('button', { name: 'Codex', exact: true }).focus()
  await expect(picker.getByRole('button', { name: 'Codex', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(picker.getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(provider).toBeFocused()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 600))
  await expect(branch).toBeInViewport()
  await expect(page.getByTestId('composer-project-name')).toBeInViewport()
  await page.screenshot({ path: join(screenshots, 'narrow.png') })
  await branch.click()
  await expect(page.getByRole('dialog', { name: 'Choose branch' })).toBeInViewport()
  await page.screenshot({ path: join(screenshots, 'narrow-branch.png') })
  await page.keyboard.press('Escape')
  await expect(branch).toBeFocused()
  console.log(`Electron checks passed: real checkout success/failure, long names, provider keyboard selection, focus restoration. Screenshots: ${screenshots}`)
  if (process.argv.includes('--manual')) {
    console.log('Ready for manual inspection. Press Enter to close and remove the temporary profile and repository.')
    process.stdin.resume()
    await new Promise((resolve) => process.stdin.once('data', resolve))
    process.stdin.pause()
  }
} finally {
  await application?.close()
  await rm(directory, { recursive: true, force: true })
}
