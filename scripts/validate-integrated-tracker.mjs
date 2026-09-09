// Run after npm run build. Uses a disposable desktop profile and repository.
import { _electron as electron, expect } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-tracker-ui-')))
const project = join(directory, 'project')
const configFile = join(directory, 'config.json')
const database = join(directory, 'workspaces', 'Default', 'anvil.db')
const screenshots = resolve(process.argv[2] ?? 'test-results/integrated-tracker')
mkdirSync(project)
mkdirSync(screenshots, { recursive: true })
execFileSync('git', ['init', '-b', 'main', project])
const seed = join(directory, 'seed.cjs')
await build({ stdin: { contents: `
  import { Store } from './src/main/store'
  import { TaskIssues } from './src/main/tasks/task-issues'
  export function seed(database, project, migrations) {
    const store = new Store(database, { migrationsFolder: migrations })
    try {
      store.addProject({ id: 'release-project', name: 'Tracker validation', path: project, createdAt: Date.now(), monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
      for (const id of ['release-task', 'second-task']) {
        store.addTask({ id, projectId: 'release-project', title: id === 'release-task' ? 'Integrated tracker review' : 'Second task', prompt: 'Validate the shared tracker', cwd: project,
          agentId: 'codex', agentLabel: 'Codex', status: 'succeeded', deliveryStatus: 'no_changes', startedAt: Date.now(),
          inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null, filesChanged: 0, additions: 0, deletions: 0 })
        new TaskIssues(store).initialize(id, project)
      }
      return store.getTaskExecution('release-task').parentIssueId
    } finally { store.close() }
  }
`, resolveDir: process.cwd(), loader: 'ts' }, outfile: seed, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const env = { ...process.env, ANVIL_DATA_DIR: directory, HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: join(directory, '.config'), SHELL: '/bin/sh', NODE_PATH: resolve('node_modules') }
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await electron.launch({ args: [process.cwd()], env })
  app.process().stderr.on('data', (chunk) => process.stderr.write(chunk))
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const executable = await app.evaluate(() => process.execPath)
  const runNode = (code, ...args) => execFileSync(executable, ['-e', code, ...args], {
    encoding: 'utf8', env: { ...env, ELECTRON_RUN_AS_NODE: '1' }
  })
  const parentId = JSON.parse(runNode('console.log(JSON.stringify(require(process.argv[1]).seed(...process.argv.slice(2))))', seed, configFile, project, resolve('src/main/db/migrations')))
  const cli = (...args) => JSON.parse(execFileSync(executable, [resolve('out/main/valence-cli.js'), '--project', project, ...args, '--json'], {
    encoding: 'utf8', env: { ...env, ELECTRON_RUN_AS_NODE: '1', ANVIL_DATABASE_PATH: database }
  }))
  expect(realpathSync(cli('status').database)).toBe(realpathSync(database))
  expect(cli('parent', 'show', parentId).anvilTaskId).toBe('release-task')
  const issue = cli('create', 'CLI-created child', '--parent', parentId, '--description', 'Written to the desktop database', '--checklist', 'Check visible status', '--validation', 'Desktop refresh')
  for (const status of ['working', 'blocked', 'complete']) {
    const child = cli('create', `${status} child`, '--parent', parentId, '--description', `${status} details`, '--checklist', 'Check', '--validation', 'Inspect')
    cli('start', child.id)
    if (status === 'blocked') cli('block', child.id)
    if (status === 'complete') cli('complete', child.id, '--confirm-checklist', '--evidence', 'Fixture status for visual inspection')
  }
  await page.reload()
  const task = page.getByRole('button', { name: 'Open task: Integrated tracker review', exact: true })
  await task.click()
  await page.getByRole('tab', { name: 'Issues', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: 'Issues' })
  await expect(panel.getByRole('listitem')).toHaveCount(4)
  await panel.getByRole('region', { name: 'Parent issue', exact: true }).getByRole('button').click()
  await expect(panel.getByText('Validate the shared tracker', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'CLI-created child Queued', exact: true }).click()
  await expect(panel.getByText('Written to the desktop database')).toBeVisible()
  const started = Date.now()
  cli('start', issue.id)
  await expect(panel.getByRole('button', { name: 'CLI-created child Working', exact: true })).toBeVisible({ timeout: 1500 })
  const refreshMs = Date.now() - started
  cli('complete', issue.id, '--confirm-checklist', '--evidence', 'Observed queued to working in the desktop')
  await expect(panel.getByRole('button', { name: 'CLI-created child Complete', exact: true })).toBeVisible({ timeout: 1500 })
  for (const [width, height] of [[1440, 900], [900, 600]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
    await page.setViewportSize({ width, height })
    await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([width, height])
    // Wait for native resize painting before capturing the Electron compositor.
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(screenshots, `desktop-${width}.png`), scale: 'css' })
  }
  await page.getByRole('button', { name: 'Open task: Second task', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Output', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Issues', exact: true }).click()
  await expect(panel.getByRole('listitem')).toHaveCount(0)
  await task.click()
  await page.getByRole('tab', { name: 'Issues', exact: true }).click()
  // Deliberately break an execution reference in this disposable profile to exercise real IPC errors.
  const execute = (sql) => runNode('const db = new (require(process.argv[1]))(process.argv[2]); try { db.exec(process.argv[3]) } finally { db.close() }', resolve('node_modules/better-sqlite3'), database, sql)
  execute("UPDATE task_executions SET state = json_set(state, '$.parentIssueId', 'missing-parent') WHERE task_id = 'release-task'")
  await expect(panel.getByRole('alert')).toContainText('Showing last known data.')
  await page.screenshot({ path: join(screenshots, 'desktop-error.png'), scale: 'css' })
  execute(`UPDATE task_executions SET state = json_set(state, '$.parentIssueId', '${parentId}') WHERE task_id = 'release-task'`)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await task.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.screenshot({ path: join(screenshots, 'desktop-delete.png'), scale: 'css' })
  await page.getByRole('dialog').getByRole('button', { name: 'Delete task', exact: true }).click()
  await expect(task).toHaveCount(0)
  expect(cli('parent', 'list').map((parent) => parent.anvilTaskId)).toEqual(['second-task'])
  expect(cli('list')).toHaveLength(0)
  console.log(JSON.stringify({ database, parentTaskId: 'release-task', refreshMs, screenshots, checks: 'parent/children, four statuses, CLI refresh, task switching, real IPC error and recovery, deletion cascade' }, null, 2))
} finally {
  await app?.close()
  rmSync(directory, { recursive: true, force: true })
}
