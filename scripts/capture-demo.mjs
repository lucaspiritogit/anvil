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
const errors = []
let frame = 0
let cursor = { x: 1180, y: 720 }
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
  browser = await chromium.launch({ headless: true })
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
  async function click(locator) {
    await expect(locator).toBeVisible()
    const box = await locator.boundingBox()
    await capture(0.35, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    await locator.click()
    await capture(0.25)
  }
  async function typePrompt(text) {
    const input = page.getByRole('textbox', { name: 'Task prompt', exact: true })
    await click(input)
    for (const character of text) {
      await input.pressSequentially(character)
      await capture(1 / fps)
    }
    await capture(0.3)
    await input.press('Enter')
    await page.getByRole('log', { name: 'Task output' }).waitFor()
    return page.evaluate(() => window.anvil.tasks.list().then((tasks) => tasks[0].id))
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
    localStorage.setItem('fixture:workspaces', JSON.stringify([
      { id: 'default', name: 'Personal', createdAt: 0 }, { id: 'studio', name: 'Studio', createdAt: 0 }
    ]))
    localStorage.setItem('fixture:preferences', JSON.stringify(Object.fromEntries(['default', 'studio'].map((id) => [id, {
      composer: { agentId: 'codex', modelsByAgent: { codex: 'gpt-5' }, reasoningByAgentModel: {} }, lastProjectId: 'project-0'
    }]))))
  })
  await page.goto('http://127.0.0.1:4188/tests/e2e/fixture/?demo&platform=darwin')
  await page.getByRole('textbox', { name: 'Task prompt', exact: true }).waitFor()
  await page.evaluate(async (wallpaper) => {
    const initial = await window.anvil.settings.get()
    const personal = { ...initial, overviewBackgroundMode: wallpaper ? 'image' : 'color', overviewWallpaperId: wallpaper ? 'demo.jpg' : null }
    if (wallpaper) window.anvil.wallpapers.read = async () => wallpaper
    window.settingsTest.apply(personal)
    await window.anvil.settings.set('studio', { ...initial, overviewBackgroundMode: 'color', overviewBackgroundColor: '#17252b' })
  }, wallpaper)
  await page.addStyleTag({ content: `
    body { padding: 28px; background: #080c11; overflow: hidden }
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
  await page.waitForTimeout(600)
  await capture(0.8)
  const parentId = await typePrompt('Add task keyboard shortcuts')
  await emit(parentId, 'message', 'I’ll add next-task and previous-task shortcuts using the existing keybinding registry.')
  await capture(1.4, { x: 1120, y: 680 })
  await emit(parentId, 'tool_use', 'Read files\nsrc/shared/keybindings.ts · src/renderer/src/components/Sidebar.tsx')
  await capture(0.8)
  await emit(parentId, 'tool_result', 'Task navigation and keybindings are ready to extend.')
  await emit(parentId, 'tool_use', 'Edit files\nAdd next-task and previous-task shortcuts')
  await capture(0.8)
  await emit(parentId, 'tool_result', 'Updated keybindings.ts and Sidebar.tsx · +28 −4')
  await emit(parentId, 'tool_use', 'Shell\nnpm run test:unit')
  await capture(0.7)
  await emit(parentId, 'tool_result', 'Test Files  12 passed\nTests       64 passed')
  await emit(parentId, 'message', 'Keyboard shortcuts are ready. Task selection wraps at either end and keeps the active task visible.')
  await updateTask(parentId, { status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), workingStartedAt: undefined, workingTimeMs: 18000, filesChanged: 2, additions: 28, deletions: 4 })
  await capture(1.3)
  await page.screenshot({ path: join(output, 'demo-agent-preview.png') })
  await click(page.getByRole('button', { name: 'New task', exact: true }))
  const childId = await typePrompt('Add shortcut hints')
  await emit(childId, 'message', 'The hints use the keyboard shortcuts from the previous task. I can stack this change on that branch.')
  await updateTask(childId, { stackSuggestion: { parentTaskId: parentId, paths: ['src/shared/keybindings.ts'] } })
  await capture(1.4, { x: 1100, y: 640 })
  const childRow = page.getByRole('button', { name: 'Open task: Add shortcut hints', exact: true })
  const originalHeight = (await childRow.boundingBox()).height
  await click(page.getByRole('button', { name: 'Stack', exact: true }))
  await expect(page.getByRole('button', { name: 'Stacked on Add task keyboard shortcuts', exact: true })).toBeVisible()
  await capture(1.4)
  const compactHeight = (await childRow.boundingBox()).height
  if (compactHeight >= originalHeight) throw new Error(`Stack did not shrink: ${originalHeight} -> ${compactHeight}`)
  await emit(childId, 'tool_use', 'Edit files\nShow the shortcut beside each navigation action')
  await capture(0.7)
  await emit(childId, 'tool_result', 'Added shortcut hints · +6 −0')
  await emit(childId, 'message', 'Added the shortcut hints on top of the keyboard-shortcuts task. Ready for review.')
  await updateTask(childId, { status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), workingStartedAt: undefined, workingTimeMs: 6000, filesChanged: 1, additions: 6 })
  await capture(1.0)
  await click(page.getByRole('button', { name: 'New task', exact: true }))
  const nextChildId = await typePrompt('Add shortcut tooltips')
  await emit(nextChildId, 'message', 'I’ll add tooltips on top of the same keyboard-shortcuts task.')
  await updateTask(nextChildId, { stackSuggestion: { parentTaskId: parentId, paths: ['src/shared/keybindings.ts'] } })
  await capture(0.8)
  await click(page.getByRole('button', { name: 'Stack', exact: true }))
  await capture(0.8)
  const nextChildRow = page.getByRole('button', { name: 'Open task: Add shortcut tooltips', exact: true })
  const parentRow = page.getByRole('button', { name: 'Open task: Add task keyboard shortcuts', exact: true })
  const parentBox = await parentRow.boundingBox()
  const firstBox = await childRow.boundingBox()
  const secondBox = await nextChildRow.boundingBox()
  if (!(parentBox.y < firstBox.y && firstBox.y < secondBox.y)) throw new Error('Stack must read main task, first child, then second child from top to bottom')
  await emit(nextChildId, 'message', 'Shortcut tooltips are ready for review.')
  await updateTask(nextChildId, { status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), workingStartedAt: undefined, workingTimeMs: 3000, filesChanged: 1, additions: 4 })
  await capture(0.6)
  await click(page.getByRole('button', { name: 'New task', exact: true }))
  await capture(1.1)
  await page.screenshot({ path: join(output, 'demo-stack-preview.png') })
  const picker = page.getByRole('combobox', { name: 'Workspace', exact: true })
  await click(picker)
  await capture(0.4)
  await click(page.getByRole('option').filter({ hasText: 'Studio' }))
  await capture(1.0)
  await page.screenshot({ path: join(output, 'demo-workspace-preview.png') })
  await click(picker)
  await capture(0.3)
  await click(page.getByRole('option').filter({ hasText: 'Personal' }))
  await expect(childRow).toBeVisible()
  await capture(1.2, { x: 1180, y: 720 })
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`Captured ${frame} frames, ${(frame / fps).toFixed(2)} seconds. Stack row: ${originalHeight}px -> ${compactHeight}px.`)
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
