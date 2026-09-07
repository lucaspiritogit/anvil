import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Issue } from 'valence'
import { taskIssueLabel } from '../src/shared/valence'
import { Store } from '../src/main/store'
import { registerIpc } from '../src/main/ipc'
import { handlers, testHome, AgentProcessManager } from './issue-tracker-doubles'

async function main(): Promise<void> {
  // Install a separate Node client. Never rebuild Anvil's Electron addon for Node.
  const nodeExecutable = process.env.ANVIL_TEST_NODE!
  const npmCli = process.env.npm_execpath!
  assert.ok(nodeExecutable && npmCli, 'Run this suite through npm run test:issue-tracker')
  const clientDirectory = join(testHome, 'node-client')
  const installed = spawnSync(nodeExecutable, [npmCli, 'install', '--prefix', clientDirectory,
    '--omit=dev', '--no-audit', '--no-fund', resolve('vendor/valence-0.1.0.tgz')], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_PATH: undefined }
  })
  assert.equal(installed.status, 0, installed.error?.message ?? installed.stderr)
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome
  const projectPath = join(testHome, 'client-project')
  mkdirSync(projectPath)
  const cliPath = join(clientDirectory, 'node_modules/valence/dist/cli.js')
  const cli = (...args: string[]): any => {
    const result = spawnSync(nodeExecutable, [cliPath, ...args, '--json'], {
      cwd: projectPath, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_PATH: undefined }
    })
    assert.equal(result.status, 0, result.error?.message ?? result.stderr)
    return JSON.parse(result.stdout)
  }
  const initialized = cli('init', '--config')
  assert.equal(initialized.database, join(testHome, '.config/valence/client-project/sqlite.db'))
  const prerequisite: Issue = cli('create', 'External prerequisite', '--description', 'Owned by another client', '--checklist', 'Verify', '--validation', 'Run test', '--priority', 'urgent')
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const database = join(testHome, '.anvil-composer/anvil.db')
  const store = new Store(database, options)
  store.addProject({ id: 'project', name: 'Test', path: projectPath, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const { agentProcesses: processes } = registerIpc(() => null)
  const agentProcesses = processes as unknown as AgentProcessManager
  const call = (name: string, input: unknown): any => handlers.get(name)!(null, input)
  const tick = async (): Promise<void> => { for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve)) }
  const task = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Share Valence with a Node client' })
  await tick()
  const input = { title: 'App issue', description: 'One behavior', checklist: ['Verify'], validation: 'Run test' }
  const createTaskIssue = (title: string, ...options: string[]): Issue => cli('create', title,
    '--description', input.description, '--checklist', 'Verify', '--validation', input.validation,
    '--label', taskIssueLabel(task.id), ...options)
  const dependent = createTaskIssue('Dependent', '--dependency', prerequisite.id, '--priority', 'urgent')
  const independent = createTaskIssue('Independent', '--priority', 'low')
  agentProcesses.finishTurn(task.id, 'Created the plan through vl.')
  await tick()
  const [dependentId, independentId] = store.getTaskExecution(task.id)!.issueIds
  assert.deepEqual([dependentId, independentId], [dependent.id, independent.id])
  assert.equal(cli('show', independentId).status, 'working')
  assert.equal(cli('show', dependentId).status, 'queued')
  assert.equal(cli('show', prerequisite.id).status, 'queued', 'Anvil cannot claim an external prerequisite')
  assert.equal(existsSync(join(projectPath, '.valence')), false, 'Reuse config storage without creating a second database')
  cli('start', prerequisite.id)
  cli('complete', prerequisite.id, '--confirm-checklist', '--evidence', 'External validation passed')
  cli('complete', independentId, '--confirm-checklist', '--evidence', 'App validation passed')
  agentProcesses.finishTurn(task.id)
  await tick()
  assert.equal(cli('show', dependentId).status, 'working', 'External completion unlocks an Anvil dependent')
  cli('complete', dependentId, '--confirm-checklist', '--evidence', 'Dependent validation passed')
  agentProcesses.finishTurn(task.id)
  await tick()
  assert.equal(store.getTask(task.id)?.status, 'succeeded')
  assert.equal(cli('show', dependentId).evidence, 'Dependent validation passed')

  const interrupted = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Interrupted work' })
  await tick()
  agentProcesses.plan(interrupted.id, [{ ...input, key: 'interrupted' }])
  await tick()
  const interruptedId = store.getTaskExecution(interrupted.id)!.currentIssueId!
  const external = cli('create', 'External working issue', '--description', 'Keep working through app restarts', '--checklist', 'Verify', '--validation', 'Run test')
  cli('start', external.id)
  const beforeRestart = cli('list')
  // Model a terminated application, not a cancellation that releases its claims.
  agentProcesses.active.clear()
  registerIpc(() => null)
  assert.equal(store.getTask(interrupted.id)?.status, 'pending')
  assert.equal(store.getTaskExecution(interrupted.id)?.phase, 'blocked')
  assert.deepEqual(cli('list'), beforeRestart, 'Restart must not mutate any Valence issues')
  cli('requeue', interruptedId)
  cli('start', interruptedId)
  call('tasks:delete', interrupted.id)
  assert.equal(cli('show', interruptedId).status, 'working', 'A new Anvil process does not own the old claim')
  assert.equal(cli('show', external.id).status, 'working')
  call('tasks:delete', task.id)
  assert.equal(cli('show', dependentId).status, 'complete', 'Deleting a task preserves issue history')
  assert.equal(store.getTaskExecution(task.id), undefined)
  store.close()
  console.log('Valence clients passed: Node CLI/Electron interoperability, config discovery, external dependencies, restart isolation, and independent history.')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
