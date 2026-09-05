import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { registerIpc } from '../src/main/ipc'
import { handlers, testHome, AgentRunner } from './issue-tracker-doubles'

async function main(): Promise<void> {
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git(testHome, 'init', '-b', 'main')
  git(testHome, 'config', 'user.name', 'Anvil test')
  git(testHome, 'config', 'user.email', 'anvil-test@example.invalid')
  git(testHome, 'commit', '--allow-empty', '-m', 'Initial commit')
  const database = join(testHome, '.anvil-composer/anvil.db')
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const seed = new Store(database, options)
  seed.addProject({ id: 'project', name: 'Git test', path: testHome, createdAt: Date.now(), monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })

  const { runner: realRunner } = registerIpc(() => null)
  const runner = realRunner as unknown as AgentRunner
  const call = (name: string, input: unknown): any => handlers.get(name)!(null, input)
  const waitFor = async (condition: () => boolean): Promise<void> => {
    const until = Date.now() + 10_000
    while (!condition()) {
      if (Date.now() > until) throw new Error('Timed out waiting for board transition')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const run = await call('runs:start', { projectId: 'project', agentId: 'codex', prompt: 'Two independent files' })
  assert.equal(run.status, 'running', run.error)
  await waitFor(() => runner.starts.length === 1)
  const item = { key: 'first', labels: ['files'], priority: 'medium', dependencies: [], status: 'queued', title: 'Add one file', description: 'One file per review', checklist: ['File exists'], validation: 'Read the file' }
  runner.result(run.id, { items: [item, { ...item, key: 'second', dependencies: ['first'] }] })
  await waitFor(() => runner.starts.length === 2)
  let board = seed.getIssueTracker(run.id)!
  const firstCwd = runner.starts[1].cwd
  assert.notEqual(firstCwd, testHome)
  writeFileSync(join(firstCwd, 'first.txt'), 'first change\n')
  git(firstCwd, 'add', 'first.txt')
  git(firstCwd, 'commit', '-m', 'feat: first file')
  runner.result(run.id, { id: board.items[0].id, status: 'complete', checklist: [true], evidence: 'Read first.txt and verified its content' })
  await waitFor(() => runner.starts.length === 3)
  assert.equal(existsSync(firstCwd), true, 'Worktree remains until the entire task finishes')
  assert.equal(seed.getRun(run.id)?.deliveryStatus, 'working')
  const secondCwd = runner.starts[2].cwd
  assert.ok(existsSync(join(secondCwd, 'first.txt')), 'Next issue continues in the same worktree')
  writeFileSync(join(secondCwd, 'second.txt'), 'second change\n')
  // Exercise Anvil's fallback commit for an agent that leaves a dirty worktree.
  board = seed.getIssueTracker(run.id)!
  runner.result(run.id, { id: board.items[1].id, status: 'complete', checklist: [true], evidence: 'Read second.txt and verified its content' })
  await waitFor(() => seed.getRun(run.id)?.deliveryStatus === 'reviewable')
  assert.equal(existsSync(secondCwd), false, 'Final worktree is cleaned up')
  const wholeDiff = await call('runs:diff', run.id)
  assert.match(wholeDiff.patch, /first.txt/)
  assert.match(wholeDiff.patch, /second.txt/)
  await call('runs:approve', run.id)
  assert.equal(seed.getIssueTracker(run.id)!.phase, 'complete')
  assert.equal(git(testHome, 'branch', '--show-current'), 'main')
  assert.equal(existsSync(join(testHome, 'first.txt')), false)
  seed.close()
  console.log('Issue tracker Git integration passed: sequential work in one worktree, cumulative diff, cleanup, and final task approval.')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
