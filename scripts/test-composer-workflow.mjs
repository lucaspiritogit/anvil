import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { _electron as electron, expect } from '@playwright/test'
import sharp from 'sharp'

// Run after npm run build. Uses a temporary repo/profile and fake agent by default.
// --manual leaves the tested app open. --live-codex /absolute/path observes only
// turn acceptance from that server, then terminates it before running tools.
const directory = await mkdtemp(join(tmpdir(), 'anvil-composer-workflow-'))
const project = join(directory, 'Workflow project')
const bin = join(directory, 'bin')
const transcript = join(directory, 'transport.jsonl')
const screenshots = resolve('test-results/workflow-electron')
const liveIndex = process.argv.indexOf('--live-codex')
const liveCodex = liveIndex >= 0 ? process.argv[liveIndex + 1] : undefined
if (liveIndex >= 0 && !liveCodex?.startsWith('/')) throw new Error('Pass an absolute Codex executable path')
let model = 'smoke-vision'
await mkdir(project)
await mkdir(bin)
await mkdir(screenshots, { recursive: true })
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim()
git('init', '-b', 'main')
await writeFile(join(project, 'reference.txt'), 'FILE_CONTENT_MUST_NOT_BE_INJECTED_91b67\n')
git('add', 'reference.txt')
git('-c', 'user.name=Workflow test', '-c', 'user.email=workflow@example.invalid', 'commit', '-m', 'Initial fixture')
git('branch', 'feature/workflow')
await writeFile(join(bin, 'codex'), `#!${process.execPath}\nrequire(${JSON.stringify(resolve('tests/fixtures/composer-codex.cjs'))})\n`, { mode: 0o755 })
// Make shell PATH discovery deterministic without reading the user's startup files.
await writeFile(join(bin, 'shell'), `#!${process.execPath}\nprocess.stdout.write('\\0' + process.env.PATH + '\\n\\0')\n`, { mode: 0o755 })
const env = {
  ...process.env, HOME: directory, CFFIXED_USER_HOME: directory, USERPROFILE: directory,
  ...(liveCodex ? { CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), '.codex') } : {}),
  ANVIL_DATA_DIR: join(directory, 'profile'), ANVIL_MEMORY_BACKEND: 'disabled',
  PATH: `${bin}:${process.env.PATH}`, SHELL: join(bin, 'shell'),
  ANVIL_SMOKE_TRANSCRIPT: transcript, ANVIL_SMOKE_LIVE_CODEX: liveCodex ?? ''
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let executablePath
if (process.argv.includes('--manual') && process.platform === 'darwin') {
  const bundle = join(directory, 'Workflow Verification.app')
  await cp(resolve('node_modules/electron/dist/Electron.app'), bundle, { recursive: true, verbatimSymlinks: true })
  executablePath = join(bundle, 'Contents/MacOS/Electron')
  console.log(`Inspection app: ${bundle}`)
}
let application
let clipboardBackup
try {
  application = await electron.launch({ executablePath, args: ['.'], env })
  application.context().setDefaultTimeout(20000)
  const page = await application.firstWindow()
  await application.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] })
  }, project)
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await page.getByRole('combobox', { name: 'Project', exact: true }).fill('Workflow')
  await page.getByRole('option').filter({ hasText: project }).click()
  const [selectedProject] = await page.evaluate(() => window.anvil.projects.list())
  if (liveCodex) {
    const catalogue = await page.evaluate(() => window.anvil.agents.models('codex'))
    if (catalogue.error || !catalogue.models.length) throw new Error(`Live Codex unavailable: ${catalogue.error ?? 'empty model catalogue'}`)
    model = catalogue.models.includes('gpt-5.6-sol') ? 'gpt-5.6-sol' : catalogue.models[0]
    console.log(`Live model: ${model}`)
  }
  clipboardBackup = await application.evaluate(({ clipboard }) => clipboard.availableFormats().map((format) => [format, Array.from(clipboard.readBuffer(format))]))
  const png = await sharp({ create: { width: 48, height: 32, channels: 4, background: '#6789ab' } }).png().toBuffer()
  const entries = async () => (await readFile(transcript, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  for (const placement of ['overview', 'modal']) {
    if (placement === 'modal') await page.getByRole('button', { name: 'New task', exact: true }).click()
    const surface = placement === 'modal' ? page.getByRole('dialog', { name: 'Start new task' }) : page.getByTestId('project-overview')
    const branch = surface.getByRole('button', { name: 'Project branch', exact: true })
    await expect(surface.getByTestId('composer-project-name')).toHaveText('Workflow project')
    await branch.click()
    await page.getByRole('dialog', { name: 'Choose branch' }).getByRole('button', { name: placement === 'overview' ? 'feature/workflow' : 'main', exact: true }).click()
    const selectedBranch = placement === 'overview' ? 'feature/workflow' : 'main'
    await expect(branch).toHaveAccessibleDescription(selectedBranch)
    assert.equal(git('branch', '--show-current'), selectedBranch)
    const composer = surface.getByRole('form', { name: 'Start a task' })
    await composer.getByRole('button', { name: /Choose a model|Model:/ }).click()
    await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: 'Codex', exact: true }).click()
    await page.getByRole('dialog', { name: 'Choose model' }).getByTitle(model, { exact: true }).click()
    const prompt = composer.getByRole('textbox', { name: 'Task prompt' })
    await prompt.fill('Smoke check. Do not execute tools. Inspect @ref')
    await expect(page.getByRole('option', { name: 'reference.txt', exact: true })).toBeVisible()
    await prompt.press('Enter')
    await prompt.press('Shift+Enter')
    await prompt.pressSequentially(`Image from ${placement}`)
    await page.evaluate(() => {
      window.smokePastedImage = new Promise((resolve) => document.addEventListener('paste', async (event) => {
        const file = Array.from(event.clipboardData.items).find((item) => item.type === 'image/png').getAsFile()
        resolve(Array.from(new Uint8Array(await file.arrayBuffer())))
      }, { once: true }))
    })
    await application.evaluate(({ clipboard, nativeImage }, bytes) => {
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(bytes)))
      return Array.from(clipboard.readImage().toPNG())
    }, Array.from(png))
    await prompt.press('ControlOrMeta+V')
    const expectedBytes = await page.evaluate(() => window.smokePastedImage)
    assert.deepEqual(await sharp(Buffer.from(expectedBytes)).ensureAlpha().raw().toBuffer(), await sharp(png).ensureAlpha().raw().toBuffer())
    await expect(composer.getByRole('img')).toHaveCount(1)
    await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    for (const width of [1280, 600]) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
      await expect(prompt).toBeInViewport()
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.screenshot({ path: join(screenshots, `${placement}-${width}.png`) })
    }
    const before = (await entries()).filter((entry) => entry.method === 'turn/start').length
    await prompt.press('Enter')
    await expect.poll(async () => (await entries()).filter((entry) => entry.method === 'turn/start').length, { timeout: 30000 }).toBe(before + 1)
    const requests = await entries()
    const turn = requests.filter((entry) => entry.method === 'turn/start').at(-1)
    const thread = requests.filter((entry) => entry.method === 'thread/start').at(-1)
    assert.equal(thread.params.model, model)
    const text = turn.params.input[0].text
    assert.ok(text.includes(JSON.stringify(['reference.txt'])))
    assert.ok(!text.includes('FILE_CONTENT_MUST_NOT_BE_INJECTED_91b67'))
    const received = Buffer.from(turn.params.input[1].url.split(',')[1], 'base64')
    assert.equal(turn.params.input[1].type, 'image')
    assert.deepEqual(received, Buffer.from(expectedBytes))
    const task = (await page.evaluate(() => window.anvil.tasks.list()))[0]
    assert.equal(task.projectId, selectedProject.id)
    assert.equal(task.agentId, 'codex')
    assert.equal(task.model, model)
    assert.equal(task.baseBranch, selectedBranch)
    assert.equal(thread.params.cwd, task.cwd)
    await expect.poll(async () => (await entries()).filter((entry) => entry.accepted === true).length).toBe(before + 1)
    console.log(`${placement}: project/provider/model/base branch/cwd/path-only reference and ${received.length} PNG bytes verified; sha256 ${createHash('sha256').update(received).digest('hex')}; ${liveCodex ? 'real' : 'fake'} Codex accepted turn.`)
    await page.evaluate((id) => window.anvil.tasks.cancel(id), task.id)
  }
  if (process.argv.includes('--manual')) {
    console.log(`Manual inspection ready. Profile and repository: ${directory}. Press Enter to close.`)
    process.stdin.resume()
    await new Promise((resolve) => process.stdin.once('data', resolve))
    process.stdin.pause()
  }
} finally {
  if (application && clipboardBackup) await application.evaluate(({ clipboard }, saved) => {
    clipboard.clear()
    for (const [format, bytes] of saved) clipboard.writeBuffer(format, Buffer.from(bytes))
  }, clipboardBackup)
  await application?.close()
  await rm(directory, { recursive: true, force: true })
}
