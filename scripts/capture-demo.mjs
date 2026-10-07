import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Capture the real renderer with the fixture bridge. No agents or user tasks run.
const output = resolve(process.argv[2] || 'public/showcase')
const frames = await mkdtemp(join(tmpdir(), 'anvil-demo-frames-'))
const fps = 25
const durationSeconds = 26
const targetFrames = fps * durationSeconds
const errors = []
let frame = 0
let cursor = { x: 1370, y: 840 }
await mkdir(output, { recursive: true })
const wallpaperPath = process.env.ANVIL_DEMO_WALLPAPER || join(homedir(), '.anvil-composer/workspaces/Default/wallpaper/wallpaper3.jpeg')
let wallpaper
try {
  wallpaper = `data:image/jpeg;base64,${(await readFile(wallpaperPath)).toString('base64')}`
} catch {
  // The demo also runs on a clean checkout without a personal wallpaper.
  wallpaper = null
}
const server = await createServer({ configFile: resolve('tests/e2e/vite.config.mts'), server: { port: 4188 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, executablePath: process.env.ANVIL_DEMO_BROWSER || undefined })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => errors.push(error.message))
  async function capture(seconds, target = cursor) {
    const count = Math.max(1, Math.round(seconds * fps))
    const start = { ...cursor }
    for (let index = 1; index <= count; index++) {
      const progress = index / count
      const ease = progress * progress * (3 - 2 * progress)
      cursor = { x: start.x + (target.x - start.x) * ease, y: start.y + (target.y - start.y) * ease }
      await page.evaluate((position) => {
        document.getElementById('demo-cursor').style.transform = `translate(${position.x}px, ${position.y}px)`
      }, cursor)
      await page.screenshot({ path: join(frames, `${String(frame++).padStart(5, '0')}.png`) })
    }
  }
  async function focusNewTask() {
    await page.keyboard.press('Meta+n')
    await expect(page.getByRole('textbox', { name: 'Task prompt', exact: true })).toBeFocused()
    await capture(0.2)
  }
  async function centerOf(locator) {
    const box = await locator.boundingBox()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  async function chooseFromMenu(name, option, { hold = 0.35 } = {}) {
    const trigger = page.getByRole('combobox', { name, exact: true })
    await capture(0.35, await centerOf(trigger))
    await trigger.click()
    const choice = page.getByRole('listbox', { name, exact: true }).getByRole('option', { name: option, exact: true })
    await expect(choice).toBeVisible()
    await capture(hold, await centerOf(choice))
    await choice.click()
    await expect(trigger).toHaveText(option)
    await capture(0.2)
  }
  async function switchToWork() {
    await chooseFromMenu('Task style', 'Work', { hold: 0.5 })
    await focusNewTask()
  }
  async function typePrompt(text) {
    const input = page.getByRole('textbox', { name: 'Task prompt', exact: true })
    await expect(input).toBeFocused()
    for (const character of text) {
      await input.pressSequentially(character)
      await capture(1 / fps)
    }
    await capture(0.16)
    await input.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: 'Task created' })).toBeVisible()
    await capture(0.45)
    return page.evaluate(() => window.anvil.tasks.list().then((tasks) => tasks[0].id))
  }
  async function openTask(title) {
    const row = page.getByRole('button', { name: `Open task: ${title}`, exact: true })
    await capture(0.4, await centerOf(row))
    await row.click()
    await page.getByRole('log', { name: 'Task output' }).waitFor()
    await capture(0.15)
  }
  async function emit(taskId, category, text) {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('fixture:output', {
      detail: { ...detail, id: crypto.randomUUID(), ts: Date.now(), stream: 'stdout', kind: 'output' }
    })), { taskId, category, text })
  }
  async function updateTask(taskId, patch) {
    await page.evaluate(async ({ taskId, patch }) => {
      const task = (await window.anvil.tasks.list()).find((task) => task.id === taskId)
      window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, ...patch } }))
    }, { taskId, patch })
  }
  await page.addInitScript(() => {
    localStorage.setItem('fixture:workspaces', JSON.stringify([{ id: 'default', name: 'Personal', createdAt: 0 }]))
    localStorage.setItem('fixture:preferences', JSON.stringify({
      default: { composer: { agentId: 'codex', modelsByAgent: { codex: 'gpt-5' }, reasoningByAgentModel: {} }, lastProjectId: 'project-0' }
    }))
  })
  await page.goto('http://127.0.0.1:4188/tests/e2e/fixture/?demo&platform=darwin')
  await page.getByRole('textbox', { name: 'Task prompt', exact: true }).waitFor()
  await page.evaluate(async (wallpaper) => {
    const initial = await window.anvil.settings.get()
    const personal = { ...initial, overviewBackgroundMode: wallpaper ? 'image' : 'color', overviewWallpaperId: wallpaper ? 'demo.jpg' : null }
    if (wallpaper) window.anvil.wallpapers.read = async () => wallpaper
    window.settingsTest.apply(personal)
  }, wallpaper)
  await page.addStyleTag({ content: `
    body { padding: 28px; background: #08090b; overflow: hidden }
    #root { height: calc(100vh - 56px); width: calc(100vw - 56px); border-radius: 12px; overflow: hidden; box-shadow: 0 16px 60px #0008; border: 1px solid #ffffff18 }
    * { cursor: none !important }
    #demo-cursor { position: fixed; top: 0; left: 0; width: 18px; height: 23px; z-index: 99999; pointer-events: none; filter: drop-shadow(0 2px 2px #0009) }
  ` })
  await page.evaluate(() => {
    const cursor = document.createElement('div')
    cursor.id = 'demo-cursor'
    cursor.innerHTML = '<svg viewBox="0 0 18 23"><path d="M2 1L2 19L6.7 14.9L10.2 22L13.5 20.4L10 13.6L16 13Z" fill="white" stroke="#17212a" stroke-width="1.3"/></svg>'
    document.body.append(cursor)
  })
  await page.evaluate(async () => {
    await window.anvil.accounts.connect({ workspaceId: 'default', agentId: 'codex', method: 'browser' })
    window.dispatchEvent(new CustomEvent('fixture:account-complete', { detail: { workspaceId: 'default', agentId: 'codex', success: true } }))
  })
  await page.waitForTimeout(600)
  await expect(page.getByRole('region', { name: 'Codex usage limits', exact: true })).toBeVisible()
  await capture(1.2)
  await page.screenshot({ path: join(output, 'demo-workspace-preview.png') })

  await focusNewTask()
  const quickTaskId = await typePrompt('Tighten analytics date controls')
  await openTask('Tighten analytics date controls')
  await emit(quickTaskId, 'message', 'I’ll update the date controls in the current checkout and keep the change focused.')
  await capture(0.7)
  await emit(quickTaskId, 'tool_use', 'Edit file\napps/web/src/components/AnalyticsPage.tsx')
  await capture(0.65)
  await emit(quickTaskId, 'tool_result', 'Updated AnalyticsPage.tsx · +8 −3')
  await emit(quickTaskId, 'message', 'The date controls are ready to review.')
  await updateTask(quickTaskId, { status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), workingStartedAt: undefined, workingTimeMs: 8000, filesChanged: 1, additions: 8, deletions: 3, inputTokens: 18_400, outputTokens: 720, totalTokens: 19_120 })
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Done')
  await capture(0.9)
  await page.screenshot({ path: join(output, 'demo-agent-preview.png') })

  await focusNewTask()
  await switchToWork()
  const parentTaskId = await typePrompt('Add provider usage limits')
  await emit(parentTaskId, 'message', 'I’ll add workspace usage limits and keep the provider data isolated behind the account bridge.')
  await emit(parentTaskId, 'tool_use', 'Read files\nWorkspaceUsageLimits.tsx · ProviderLimits.tsx')
  await capture(0.6)

  await focusNewTask()
  await switchToWork()
  await expect(page.getByRole('combobox', { name: 'Stack on task', exact: true })).toBeVisible()
  await chooseFromMenu('Stack on task', 'Add provider usage limits', { hold: 0.45 })
  await focusNewTask()
  const childTaskId = await typePrompt('Polish provider limit meters')
  await updateTask(childTaskId, { deliveryStatus: 'preparing', branchName: undefined, sessionId: undefined })
  await expect(page.getByRole('button', { name: 'Collapse stack: Add provider usage limits', exact: true })).toBeVisible()
  await capture(0.8)

  await focusNewTask()
  await switchToWork()
  const autoTaskId = await typePrompt('Show limit reset countdown')
  await updateTask(autoTaskId, { parentTaskId, stackOrigin: 'auto', baseBranch: `anvil/${parentTaskId}` })
  await expect(page.getByRole('button', { name: 'Open task: Show limit reset countdown', exact: true })).toContainText('⠿ anvil')
  await capture(0.8)

  await openTask('Show limit reset countdown')
  await expect(page.getByRole('button', { name: 'Stacked on Add provider usage limits', exact: true })).toBeVisible()
  await emit(autoTaskId, 'message', 'I’ll build on the provider limit panel from the parent branch and add a reset countdown.')
  await emit(autoTaskId, 'tool_use', 'Edit file\napps/web/src/components/ProviderLimits.tsx')
  await capture(0.6)
  await emit(autoTaskId, 'tool_result', 'Updated ProviderLimits.tsx · +31 −4')
  await emit(parentTaskId, 'tool_result', 'Updated 3 files · +74 −6')
  await updateTask(parentTaskId, { status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), workingStartedAt: undefined, workingTimeMs: 21_000, filesChanged: 3, additions: 74, deletions: 6, inputTokens: 42_800, outputTokens: 1_960, totalTokens: 44_760 })
  await updateTask(autoTaskId, { status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), workingStartedAt: undefined, workingTimeMs: 12_000, filesChanged: 2, additions: 31, deletions: 4, inputTokens: 23_100, outputTokens: 880, totalTokens: 23_980 })
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Succeeded')
  await page.mouse.move(880, 620)
  await capture(1.0, { x: 880, y: 620 })
  await page.screenshot({ path: join(output, 'demo-stack-preview.png') })

  const collapseStack = page.getByRole('button', { name: 'Collapse stack: Add provider usage limits', exact: true })
  await capture(0.4, await centerOf(collapseStack))
  await collapseStack.click()
  await expect(page.getByRole('button', { name: 'Open task: Add provider usage limits', exact: true })).toContainText('+2 stacked · 1 working')
  await capture(0.9)

  const analyticsButton = page.getByRole('button', { name: 'Analytics', exact: true })
  await capture(0.4, await centerOf(analyticsButton))
  await analyticsButton.click()
  await expect(page.getByRole('heading', { name: 'Analytics', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: /Tokens over time$/ })).toBeVisible()
  await capture(2.8)
  if (frame > targetFrames) throw new Error(`Demo ran ${(frame / fps).toFixed(2)} seconds before the final hold; expected at most ${durationSeconds}.`)
  if (frame < targetFrames) await capture((targetFrames - frame) / fps)
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`Captured ${frame} frames, ${(frame / fps).toFixed(2)} seconds.`)
} finally {
  await browser?.close()
  await server.close()
}
try {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', join(frames, '%05d.png'), '-frames:v', String(frame), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(output, 'anvil-demo.mp4')], { stdio: 'inherit' })
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(output, 'anvil-demo.mp4'), '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', join(output, 'anvil-demo.gif')], { stdio: 'inherit' })
} finally {
  await rm(frames, { recursive: true, force: true })
}
