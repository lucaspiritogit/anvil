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
const ffmpeg = process.env.ANVIL_DEMO_FFMPEG || 'ffmpeg'
const durationSeconds = 22
const targetFrames = fps * durationSeconds
const errors = []
let frame = 0
let cursor = { x: 1370, y: 840 }
const demoPatch = `diff --git a/apps/web/src/components/ProviderLimits.tsx b/apps/web/src/components/ProviderLimits.tsx
index 3f1a2b4..9c8d7e6 100644
--- a/apps/web/src/components/ProviderLimits.tsx
+++ b/apps/web/src/components/ProviderLimits.tsx
@@ -1,14 +1,23 @@
 import { Meter } from './Meter'
+import { useResetCountdown } from '../hooks/use-reset-countdown'
 import type { ProviderLimit } from '@anvil/protocol/types'
\u0020
-export function ProviderLimits({ limits }: { limits: ProviderLimit[] }) {
+export function ProviderLimits({ limits, now }: { limits: ProviderLimit[]; now: number }) {
   return (
     <ul aria-label="Provider usage limits">
       {limits.map((limit) => (
-        <li key={limit.id}>
-          <Meter label={limit.label} value={limit.used} max={limit.max} />
-        </li>
+        <ProviderLimitRow key={limit.id} limit={limit} now={now} />
       ))}
     </ul>
   )
 }
+
+function ProviderLimitRow({ limit, now }: { limit: ProviderLimit; now: number }) {
+  const reset = useResetCountdown(limit.resetsAt, now)
+  return (
+    <li>
+      <Meter label={limit.label} value={limit.used} max={limit.max} tone={limit.used / limit.max > 0.8 ? 'warn' : 'ok'} />
+      <span className="text-dim">Resets in {reset}</span>
+    </li>
+  )
+}
diff --git a/apps/web/src/components/WorkspaceUsageLimits.tsx b/apps/web/src/components/WorkspaceUsageLimits.tsx
index 7a6b5c4..1d2e3f4 100644
--- a/apps/web/src/components/WorkspaceUsageLimits.tsx
+++ b/apps/web/src/components/WorkspaceUsageLimits.tsx
@@ -8,4 +8,7 @@ export function WorkspaceUsageLimits() {
   const limits = useStore((state) => state.providerLimits)
+  const now = useNow(1000)
   if (!limits.length) return null
-  return <ProviderLimits limits={limits} />
+  return <section aria-label="Usage limits">
+    <ProviderLimits limits={limits} now={now} />
+  </section>
 }
`
const demoEdit = (taskId) => ({
  path: `/tmp/anvil-worktrees/${taskId}/apps/web/src/components/ProviderLimits.tsx`, additions: 12, deletions: 3,
  hunks: `@@ -14,8 +14,16 @@
 export function ProviderLimits({ limits, now }: { limits: ProviderLimit[]; now: number }) {
-        <li key={limit.id}>
-          <Meter label={limit.label} value={limit.used} max={limit.max} />
-        </li>
+        <ProviderLimitRow key={limit.id} limit={limit} now={now} />
       ))}
     </ul>
   )
 }
+
+function ProviderLimitRow({ limit, now }: { limit: ProviderLimit; now: number }) {
+  const reset = useResetCountdown(limit.resetsAt, now)
+  return (
+    <li>
+      <Meter label={limit.label} value={limit.used} max={limit.max} />
+      <span className="text-dim">Resets in {reset}</span>
+    </li>
+  )
+}
`
})
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
  const page = await browser.newPage({ viewport: { width: 1480, height: 920 }, deviceScaleFactor: 1, colorScheme: 'dark' })
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
  async function typeInto(input, text, submit = 'Enter') {
    await expect(input).toBeFocused()
    for (const character of text) {
      await input.pressSequentially(character)
      await capture(1 / fps)
    }
    await capture(0.16)
    await input.press(submit)
  }
  async function typePrompt(text) {
    await typeInto(page.getByRole('textbox', { name: 'Task prompt', exact: true }), text)
    await expect(page.getByRole('status').filter({ hasText: 'Task created' })).toBeVisible()
    await capture(0.35)
    return page.evaluate((title) => window.anvil.tasks.list().then((tasks) => tasks.find((task) => task.title === title).id), text)
  }
  async function openTask(title) {
    const row = page.getByRole('button', { name: `Open task: ${title}`, exact: true })
    await capture(0.4, await centerOf(row))
    await row.click()
    await page.getByRole('log', { name: 'Task output' }).waitFor()
    await capture(0.15)
  }
  async function emit(taskId, category, text, extra = {}) {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('fixture:output', {
      detail: { id: crypto.randomUUID(), ts: Date.now(), stream: 'stdout', kind: 'output', ...detail }
    })), { taskId, category, text, ...extra })
  }
  async function updateTask(taskId, patch) {
    await page.evaluate(async ({ taskId, patch }) => {
      const task = (await window.anvil.tasks.list()).find((task) => task.id === taskId)
      window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, ...patch } }))
    }, { taskId, patch })
  }
  async function seedTask(prompt, projectId, patch) {
    await page.evaluate(async ({ prompt, projectId, patch }) => {
      const task = await window.anvil.tasks.start({ workspaceId: 'default', projectId, prompt, agentId: 'codex', model: 'gpt-5' })
      window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, ...patch } }))
    }, { prompt, projectId, patch })
  }
  const finished = (minutesAgo, patch) => ({
    status: 'succeeded', startedAt: Date.now() - minutesAgo * 60_000, endedAt: Date.now() - (minutesAgo - 4) * 60_000,
    workingStartedAt: undefined, workingTimeMs: 4 * 60_000, ...patch
  })
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
  await page.evaluate((patch) => { window.anvil.tasks.diff = async () => ({ patch, commits: [{ sha: '8f3c2a1d9e4b7c60', subject: 'feat: show provider usage limits' }] }) }, demoPatch)
  await page.addStyleTag({ content: `
    body { padding: 24px; background: #08090b; overflow: hidden }
    #root { height: calc(100vh - 48px); width: calc(100vw - 48px); border-radius: 12px; overflow: hidden; box-shadow: 0 16px 60px #0008; border: 1px solid #ffffff18 }
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
  await seedTask('Bump Vite to 7', 'project-1', finished(95, { deliveryStatus: 'approved', shippedCommit: 'a1b2c3d', pushedCommit: 'a1b2c3d', reviewedAt: Date.now() - 80 * 60_000, filesChanged: 2, additions: 4, deletions: 4 }))
  await seedTask('Fix flaky login redirect test', 'project-1', finished(40, { deliveryStatus: 'reviewable', filesChanged: 1, additions: 12, deletions: 3 }))
  await seedTask('Document the sync API', 'project-0', { status: 'running', deliveryStatus: 'working', startedAt: Date.now() - 3 * 60_000, workingStartedAt: Date.now() - 3 * 60_000 })
  await expect(page.getByRole('region', { name: 'Codex usage limits', exact: true })).toBeVisible()
  await page.waitForTimeout(400)
  await capture(1.1)
  await page.screenshot({ path: join(output, 'demo-workspace-preview.png') })

  await focusNewTask()
  const taskId = await typePrompt('Add provider usage limits')
  await openTask('Add provider usage limits')
  await emit(taskId, 'message', 'I’ll add **provider usage limits** to the workspace and keep account data behind the bridge.')
  await capture(0.5)
  await emit(taskId, 'thinking', 'The limits panel can reuse the existing meter and read resets from the account snapshot.')
  await updateTask(taskId, { inputTokens: 9_200, outputTokens: 310, totalTokens: 9_510, costUsd: 0.06 })
  await capture(0.5)
  await emit(taskId, 'tool_use', 'Read files\napps/web/src/components/WorkspaceUsageLimits.tsx · ProviderLimits.tsx')
  await emit(taskId, 'tool_result', 'Read 2 files · 214 lines')
  await capture(0.45)
  await emit(taskId, 'tool_use', 'Edit file\napps/web/src/components/ProviderLimits.tsx', { edits: [demoEdit(taskId)] })
  await emit(taskId, 'tool_result', 'Updated ProviderLimits.tsx')
  await updateTask(taskId, { inputTokens: 24_600, outputTokens: 940, totalTokens: 25_540, costUsd: 0.17 })
  await capture(0.35)
  const editsToggle = page.getByRole('button', { name: 'edits', exact: true })
  await capture(0.4, await centerOf(editsToggle))
  await editsToggle.click()
  await capture(1.1)

  const steer = page.getByRole('textbox', { name: 'Message to agent' })
  await capture(0.35, await centerOf(steer))
  await steer.click()
  await typeInto(steer, 'Also show when each limit resets', 'Alt+Enter')
  await expect(page.getByRole('list', { name: 'Queued for after this turn' })).toBeVisible()
  await capture(0.9)
  await page.screenshot({ path: join(output, 'demo-session-preview.png') })

  await focusNewTask()
  const otherTaskId = await typePrompt('Tighten analytics date controls')
  await capture(0.3)
  await openTask('Add provider usage limits')
  await updateTask(taskId, { promptQueue: [] })
  await emit(taskId, 'system', 'You (queued):\nAlso show when each limit resets', { stream: 'system', kind: 'delivery' })
  await capture(0.4)
  await emit(taskId, 'tool_use', 'Run checks\nnpm run typecheck && npm test -- provider-limits')
  await emit(taskId, 'tool_result', '✓ typecheck\n✓ 18 passed (2.4s)')
  await capture(0.45)
  await emit(taskId, 'message', 'Limits now show a live reset countdown. Typecheck and the provider tests pass.')
  await updateTask(taskId, { status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), workingStartedAt: undefined, workingTimeMs: 21_000, filesChanged: 2, additions: 34, deletions: 5, inputTokens: 42_800, outputTokens: 1_960, totalTokens: 44_760, costUsd: 0.31 })
  const ship = page.getByRole('button', { name: /^Ship( to |$)/ })
  await expect(ship).toBeEnabled()
  await expect(page.getByRole('complementary', { name: 'Changes pane' })).toBeVisible()
  await capture(1.4)
  await page.screenshot({ path: join(output, 'demo-ship-preview.png') })

  const shipCenter = await centerOf(ship)
  await capture(0.45, shipCenter)
  await page.mouse.move(shipCenter.x, shipCenter.y)
  await page.mouse.down()
  const shipped = page.getByText('Shipped & pushed', { exact: true })
  for (let held = 0; held < 60 && !(await shipped.isVisible()); held++) await capture(1 / fps)
  await page.mouse.up()
  await expect(shipped).toBeVisible()
  await updateTask(otherTaskId, { status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), workingStartedAt: undefined, workingTimeMs: 9_000, filesChanged: 1, additions: 8, deletions: 3 })
  await capture(1.2)

  const analyticsButton = page.getByRole('button', { name: 'Analytics', exact: true })
  await capture(0.45, await centerOf(analyticsButton))
  await analyticsButton.click()
  await expect(page.getByRole('heading', { name: 'Analytics', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: /Tokens over time$/ })).toBeVisible()
  await page.mouse.move(900, 560)
  await capture(1.6, { x: 900, y: 560 })
  await page.screenshot({ path: join(output, 'demo-analytics-preview.png') })
  await capture(0.4)
  if (frame > targetFrames) throw new Error(`Demo ran ${(frame / fps).toFixed(2)} seconds before the final hold; expected at most ${durationSeconds}.`)
  if (frame < targetFrames) await capture((targetFrames - frame) / fps)
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`Captured ${frame} frames, ${(frame / fps).toFixed(2)} seconds.`)
} finally {
  await browser?.close()
  await server.close()
}
try {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', join(frames, '%05d.png'), '-frames:v', String(frame), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(output, 'anvil-demo.mp4')], { stdio: 'inherit' })
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(output, 'anvil-demo.mp4'), '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', join(output, 'anvil-demo.gif')], { stdio: 'inherit' })
} finally {
  await rm(frames, { recursive: true, force: true })
}
