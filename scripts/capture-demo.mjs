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
const durationSeconds = 20
const targetFrames = fps * durationSeconds
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
  async function focusNewTask() {
    await page.keyboard.press('Meta+n')
    await expect(page.getByRole('textbox', { name: 'Task prompt', exact: true })).toBeFocused()
    await capture(0.16)
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
  async function automaticallyStackTask(taskId, parentTaskId, expectedFiles) {
    await page.evaluate(async ({ taskId, parentTaskId, expectedFiles }) => {
      const tasks = await window.anvil.tasks.list()
      const task = tasks.find((candidate) => candidate.id === taskId)
      const parent = tasks.find((candidate) => candidate.id === parentTaskId)
      window.dispatchEvent(new CustomEvent('fixture:task-updated', {
        detail: {
          ...task,
          status: 'running',
          deliveryStatus: 'preparing',
          workingStartedAt: undefined,
          branchName: undefined,
          sessionId: undefined,
          expectedFiles,
          parentTaskId,
          baseBranch: parent.branchName,
          stackSuggestion: undefined
        }
      }))
    }, { taskId, parentTaskId, expectedFiles })
  }
  async function startStackedTask(taskId) {
    await page.evaluate(async (taskId) => {
      const task = (await window.anvil.tasks.list()).find((candidate) => candidate.id === taskId)
      const next = {
        ...task,
        status: 'running',
        deliveryStatus: 'working',
        branchName: `anvil/${taskId}`,
        baseBranch: 'main',
        workingStartedAt: Date.now()
      }
      delete next.parentTaskId
      window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: next }))
    }, taskId)
  }
  async function openChanges() {
    await click(page.getByRole('tab', { name: /^Changes/ }))
    await expect(page.getByRole('combobox', { name: 'Changed file' })).toBeVisible()
  }
  async function mergeTask() {
    await click(page.getByRole('button', { name: 'Merge', exact: true }))
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('using git merge')
    await capture(0.64)
    await click(dialog.getByRole('button', { name: 'Merge', exact: true }))
    await expect(page.getByLabel('Task status', { exact: true })).toContainText('Merged')
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
    const patches = {
      parent: `diff --git a/src/shared/keybindings.ts b/src/shared/keybindings.ts
index 1111111..2222222 100644
--- a/src/shared/keybindings.ts
+++ b/src/shared/keybindings.ts
@@ -18,3 +18,5 @@ export const DEFAULT_KEYBINDINGS = {
   newTask: 'Meta+N',
+  previousTask: 'Meta+[',
+  nextTask: 'Meta+]',
   openSettings: 'Meta+,',
 }
`,
      child: `diff --git a/src/client/renderer/src/components/SidebarTask.tsx b/src/client/renderer/src/components/SidebarTask.tsx
index 3333333..4444444 100644
--- a/src/client/renderer/src/components/SidebarTask.tsx
+++ b/src/client/renderer/src/components/SidebarTask.tsx
@@ -88,4 +88,5 @@ export function SidebarTask({ task }: Props) {
       <span className="truncate">{task.title}</span>
+      <kbd className="text-dim">⌘ ]</kbd>
     </button>
   )
 }
`
    }
    window.anvil.tasks.diff = async (taskId) => {
      const task = (await window.anvil.tasks.list()).find((candidate) => candidate.id === taskId)
      const parent = task?.title === 'Add task keyboard shortcuts'
      return {
        commits: [{
          sha: parent ? '1234567890abcdef' : 'abcdef1234567890',
          subject: parent ? 'Add task navigation shortcuts' : 'Show shortcut hints'
        }],
        patch: parent ? patches.parent : patches.child
      }
    }
    window.anvil.tasks.mergePreview = async (taskId) => {
      const task = (await window.anvil.tasks.list()).find((candidate) => candidate.id === taskId)
      await new Promise((resolve) => setTimeout(resolve, 100))
      return {
        sourceBranch: task.branchName,
        targetBranch: 'main',
        sourceCommit: 'source-head',
        targetCommit: 'target-head',
        commitCount: 1
      }
    }
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
  await capture(0.48)
  await focusNewTask()
  const parentId = await typePrompt('Add task keyboard shortcuts')
  await emit(parentId, 'message', 'I’ll add next-task and previous-task shortcuts using the existing keybinding registry.')
  await capture(1.0)
  await emit(parentId, 'tool_use', 'Read files\nsrc/shared/keybindings.ts · src/client/renderer/src/components/Sidebar.tsx')
  await emit(parentId, 'tool_result', 'Task navigation and keybindings are ready to extend.')
  await emit(parentId, 'tool_use', 'Edit files\nAdd next-task and previous-task shortcuts')
  await capture(0.48)
  await focusNewTask()
  const childId = await typePrompt('Add shortcut hints')
  await emit(childId, 'message', 'This uses the same keybinding code, so I’ll queue it on the keyboard-shortcuts task.')
  await automaticallyStackTask(childId, parentId, ['src/shared/keybindings.ts'])
  await expect(page.getByRole('button', { name: 'Stacked on Add task keyboard shortcuts', exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Queued. Waiting for Add task keyboard shortcuts' })).toBeVisible()
  await capture(1.4)
  await page.screenshot({ path: join(output, 'demo-stack-preview.png') })
  const childRow = page.getByRole('button', { name: 'Open task: Add shortcut hints', exact: true })
  const parentRow = page.getByRole('button', { name: 'Open task: Add task keyboard shortcuts', exact: true })
  await click(parentRow)
  await emit(parentId, 'tool_result', 'Updated keybindings.ts · +2 −0')
  await emit(parentId, 'message', 'Task navigation wraps at either end and keeps the active task visible.')
  await updateTask(parentId, { status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), workingStartedAt: undefined, workingTimeMs: 18000, filesChanged: 1, additions: 2, deletions: 0 })
  await capture(0.4)
  await openChanges()
  await capture(1.8)
  await page.screenshot({ path: join(output, 'demo-agent-preview.png') })
  await mergeTask()
  await capture(1.2)
  await page.screenshot({ path: join(output, 'demo-workspace-preview.png') })

  await startStackedTask(childId)
  await expect(childRow.getByRole('img', { name: 'Working' })).toBeVisible()
  await capture(0.32)
  await click(childRow)
  await emit(childId, 'tool_use', 'Edit files\nShow the shortcut beside each navigation action')
  await emit(childId, 'tool_result', 'Updated SidebarTask.tsx · +1 −0')
  await capture(0.8)
  await emit(childId, 'message', 'Shortcut hints are ready for review.')
  await updateTask(childId, { status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), workingStartedAt: undefined, workingTimeMs: 6000, filesChanged: 1, additions: 1, deletions: 0 })
  await capture(0.4)
  await openChanges()
  await capture(1.4)
  await mergeTask()
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
