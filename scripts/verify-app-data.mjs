// Run after npm run pack:mac. Both apps use the same temporary macOS home.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'
import electronPath from 'electron'

if (process.platform !== 'darwin') throw new Error('This check requires macOS home isolation')
const home = await realpath(await mkdtemp(join(tmpdir(), 'anvil-data-check-')))
const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home, ANVIL_MEMORY_BACKEND: 'disabled', SHELL: '/bin/bash' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.ANVIL_DATA_DIR
const packagedPath = resolve(process.argv[2] ?? 'release/mac-arm64/Anvil.app/Contents/MacOS/Anvil')
const apps = []

async function launch(executablePath, dataDirectory, extraEnv = {}) {
  const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env: { ...env, ...extraEnv } })
  apps.push(app)
  assert.equal(await realpath(await app.evaluate(({ app }) => app.getPath('home'))), home)
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.anvil.wallpapers.directory()), join(dataDirectory, 'wallpaper'))
  return { app, page }
}

function sql(directory, statement) {
  return execFileSync('sqlite3', [join(directory, 'anvil.db'), statement], { encoding: 'utf8' }).trim()
}

function seedLiveTask(directory) {
  sql(directory, `INSERT INTO projects (id,name,path,created_at) VALUES ('project','Live project','/test',1);
    INSERT INTO tasks (id,project_id,agent_id,agent_label,prompt,title,cwd,status,started_at,delivery_status)
    VALUES ('live','project','codex','Codex','Work','Live task','/test','running',1,'working');`)
}

try {
  const productionDirectory = join(home, '.anvil-composer')
  const developmentDirectory = join(home, '.anvil-composer-dev')
  const production = await launch(packagedPath, productionDirectory)
  assert.equal(await production.app.evaluate(({ app }) => app.isPackaged), true)
  await production.page.evaluate(() => window.anvil.settings.set({ overviewBackgroundColor: '#123456' }))
  seedLiveTask(productionDirectory)

  const development = await launch(undefined, developmentDirectory)
  assert.equal(await development.app.evaluate(({ app }) => app.isPackaged), false)
  assert.notEqual(await development.app.evaluate(({ app }) => app.getPath('userData')),
    await production.app.evaluate(({ app }) => app.getPath('userData')))
  assert.deepEqual(await development.page.evaluate(() => window.anvil.projects.list()), [])
  await development.page.evaluate(() => window.anvil.settings.set({ overviewBackgroundColor: '#abcdef' }))
  assert.equal((await production.page.evaluate(() => window.anvil.settings.get())).overviewBackgroundColor, '#123456')
  assert.equal(sql(productionDirectory, "SELECT status FROM tasks WHERE id='live'"), 'running')
  seedLiveTask(developmentDirectory)

  // A second dev launch cannot bypass its profile lock with --user-data-dir.
  const duplicate = spawn(electronPath, ['.', `--user-data-dir=${join(home, 'other-profile')}`], { env, stdio: 'ignore' })
  const timeout = setTimeout(() => duplicate.kill(), 15_000)
  try {
    const [code] = await once(duplicate, 'exit')
    assert.equal(code, 0, 'Second dev instance must exit normally without opening the store')
  } finally {
    clearTimeout(timeout)
  }
  assert.equal(sql(developmentDirectory, "SELECT status FROM tasks WHERE id='live'"), 'running')

  const isolatedDirectory = join(home, 'packaged-test')
  const isolated = await launch(packagedPath, isolatedDirectory, { ANVIL_DATA_DIR: isolatedDirectory })
  assert.deepEqual(await isolated.page.evaluate(() => window.anvil.projects.list()), [])
  await development.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(development.page.getByText(join(developmentDirectory, 'wallpaper'), { exact: true })).toBeVisible()
  await development.page.screenshot({ path: '/private/tmp/anvil-dev-data-settings.png' })
  assert.equal(sql(productionDirectory, "SELECT status FROM tasks WHERE id='live'"), 'running')
  console.log('App data Electron checks passed: concurrent packaged/development apps, live-task preservation, separate settings and profiles, duplicate-instance lock, isolated packaged tests, and actual wallpaper folder display.')
} finally {
  for (const app of apps.reverse()) await app.close()
  await rm(home, { recursive: true, force: true })
}
