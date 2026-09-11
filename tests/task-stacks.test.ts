import { expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { GitDeliveryManager } from '../src/main/git-delivery'
import { TaskStacks, requireStackMergeable, requireStackParent } from '../src/main/tasks/task-stacks'
import { TaskIssues } from '../src/main/tasks/task-issues'
import { callIssueTool } from '../src/main/issue-tools/server'
import type { TaskContext } from '../src/main/tasks/context'
import { onTestCleanup } from './test-cleanup'
import { TaskBranches, temporaryTaskBranch } from '../src/main/tasks/task-branch'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anvil-stacks-'))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'source.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Base')
  const database = join(root, 'data', 'anvil.db')
  const store = new Store(database, options)
  onTestCleanup(() => store.close())
  store.addProject({ id: 'project', name: 'Project', path: repo, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const manager = new GitDeliveryManager(join(root, 'worktrees'))
  const active = new Set<string>()
  const context: TaskContext = { store, gitDelivery: manager, agentProcesses: { isRunning: (id: string) => active.has(id) } as TaskContext['agentProcesses'], send: vi.fn() }
  const stacks = new TaskStacks(context)
  const add = async (id: string, parentTaskId?: string) => {
    const parent = parentTaskId ? store.getTask(parentTaskId)! : undefined
    const base = parent ? await manager.stackBase(repo, parent.branchName) : undefined
    const prepared = await manager.prepareBranch(repo, id, id, undefined, base)
    return store.addTask({ ...prepared, id, parentTaskId, projectId: 'project', agentId: 'codex', agentLabel: 'Codex', prompt: id, title: id,
      status: 'succeeded', deliveryStatus: 'reviewable', startedAt: 0, exitCode: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
      filesChanged: 0, additions: 0, deletions: 0 })
  }
  const commit = (id: string, file: string, value: string) => {
    const task = store.getTask(id)!
    writeFileSync(join(task.cwd, file), value)
    git(task.cwd, 'add', '.')
    git(task.cwd, 'commit', '-m', id)
    store.updateTask(id, { headCommit: git(task.cwd, 'rev-parse', 'HEAD') })
  }
  const merge = async (id: string) => {
    const task = store.getTask(id)!
    await manager.merge(repo, task.branchName!, await manager.getMergePreview(repo, task.branchName!))
    store.updateTask(id, { deliveryStatus: 'approved' })
    await stacks.restackChildren(id)
  }
  return { root, repo, database, store, manager, stacks, active, add, commit, merge }
}

test('parent naming updates only owned same-project child references and preserves commit bases across restart', async () => {
  const f = await fixture()
  const original = await f.add('parent')
  const temporary = temporaryTaskBranch(original.id)
  await f.manager.renameTaskBranch(f.repo, original.id, original.branchName!, temporary)
  const parent = f.store.updateTask(original.id, { branchName: temporary, status: 'running', deliveryStatus: 'working' })!
  const child = await f.add('child', parent.id)
  const target = { branch: temporary, commit: parent.baseCommit!, oldBase: child.baseCommit!, parentTaskId: parent.id }
  f.store.updateTask(child.id, { status: 'running', restackState: 'pending', restackTarget: target })
  const pending = await f.add('pending')
  f.store.updateTask(pending.id, { restackState: 'pending', restackTarget: target })
  const unrelated = await f.add('unrelated')
  f.store.updateTask(unrelated.id, { baseBranch: temporary, restackTarget: { ...target, parentTaskId: unrelated.id } })
  const foreign = await f.add('foreign', parent.id)
  f.store.addProject({ ...f.store.getProjects()[0], id: 'foreign-project', path: join(f.root, 'foreign-project') })
  f.store.updateTask(foreign.id, { projectId: 'foreign-project', restackTarget: target })
  const otherWorkspace = f.store.createWorkspace('Other')
  f.store.addProject(f.store.getProjects()[0], otherWorkspace.id)
  f.store.addTask({ ...child, id: 'foreign-workspace', workspaceId: otherWorkspace.id, parentTaskId: undefined, baseBranch: temporary, restackTarget: target })
  const send = vi.fn()
  await new TaskBranches({ store: f.store, gitDelivery: f.manager, send }).set(parent.id, parent.workspaceId, 'feat/parent-name', () => {})
  expect(f.store.getTask(child.id)).toMatchObject({ baseBranch: 'feat/parent-name', baseCommit: child.baseCommit,
    restackTarget: { ...target, branch: 'feat/parent-name' }, status: 'running' })
  expect(f.store.getTask(pending.id)).toMatchObject({ baseBranch: pending.baseBranch, restackTarget: { ...target, branch: 'feat/parent-name' } })
  expect(f.store.getTask(unrelated.id)?.baseBranch).toBe(temporary)
  expect(f.store.getTask(unrelated.id)?.restackTarget?.branch).toBe(temporary)
  expect(f.store.getTask(foreign.id)?.baseBranch).toBe(temporary)
  expect(f.store.getTask(foreign.id)?.restackTarget?.branch).toBe(temporary)
  expect(f.store.getTask('foreign-workspace')?.restackTarget?.branch).toBe(temporary)
  expect(send.mock.calls.map(([, task]) => task.id)).toEqual(['parent', 'child', 'pending'])
  expect(git(child.cwd, 'rev-parse', 'HEAD')).toBe(child.baseCommit)
  const reopened = new Store(f.database, options)
  onTestCleanup(() => reopened.close())
  expect(reopened.getTask(child.id)?.baseBranch).toBe('feat/parent-name')
  expect(reopened.getTask(child.id)?.restackTarget).toEqual({ ...target, branch: 'feat/parent-name' })
  expect(reopened.getTask(parent.id)?.branchName).toBe('feat/parent-name')
})

test('a child persistence failure rolls back every saved name and the parent Git rename', async () => {
  const f = await fixture()
  const parent = await f.add('parent')
  const temporary = temporaryTaskBranch(parent.id)
  await f.manager.renameTaskBranch(f.repo, parent.id, parent.branchName!, temporary)
  f.store.updateTask(parent.id, { branchName: temporary, status: 'running', deliveryStatus: 'working' })
  const child = await f.add('child', parent.id)
  const update = f.store.updateTask.bind(f.store)
  vi.spyOn(f.store, 'updateTask').mockImplementation((id, patch) => {
    const result = update(id, patch)
    if (id === child.id) throw new Error('Child write failed')
    return result
  })
  const send = vi.fn()
  await expect(new TaskBranches({ store: f.store, gitDelivery: f.manager, send }).set(parent.id, parent.workspaceId, 'feat/parent-name', () => {})).rejects.toThrow('Child write failed')
  expect(f.store.getTask(parent.id)?.branchName).toBe(temporary)
  expect(f.store.getTask(child.id)?.baseBranch).toBe(temporary)
  expect(git(parent.cwd, 'branch', '--show-current')).toBe(temporary)
  expect(send).not.toHaveBeenCalled()
})

test('creates from the parent head, enforces merge order, and restacks a clean child with a final child-only diff', async () => {
  const f = await fixture()
  const parent = await f.add('parent')
  f.commit(parent.id, 'parent.txt', 'parent\n')
  const child = await f.add('child', parent.id)
  expect(child.baseCommit).toBe(f.store.getTask(parent.id)!.headCommit)
  expect(readFileSync(join(child.cwd, 'parent.txt'), 'utf8')).toBe('parent\n')
  f.commit(child.id, 'child.txt', 'child\n')
  expect(() => requireStackMergeable(f.store, child)).toThrow('parent task first')
  await f.merge(parent.id)
  const updated = f.store.getTask(child.id)!
  expect(updated.parentTaskId).toBeUndefined()
  expect(updated.restackState).toBeUndefined()
  expect(updated.baseBranch).toBe('main')
  expect(() => requireStackMergeable(f.store, updated)).not.toThrow()
  const diff = await f.manager.getDiff(f.repo, updated.baseCommit!, updated.headCommit!)
  expect(diff.patch).toContain('child.txt')
  expect(diff.patch).not.toContain('parent.txt')
})

test('defers a running child, persists the request across restart, and applies at a turn boundary', async () => {
  const f = await fixture()
  await f.add('parent')
  f.commit('parent', 'parent.txt', 'parent\n')
  const child = await f.add('child', 'parent')
  f.commit('child', 'child.txt', 'child\n')
  f.active.add(child.id)
  f.store.updateTask(child.id, { status: 'running' })
  const before = git(child.cwd, 'rev-parse', 'HEAD')
  await f.merge('parent')
  expect(f.store.getTask(child.id)?.restackState).toBe('pending')
  expect(git(child.cwd, 'rev-parse', 'HEAD')).toBe(before)
  const reopened = new Store(f.database, options)
  onTestCleanup(() => reopened.close())
  expect(reopened.getTask(child.id)?.restackTarget?.branch).toBe('main')
  f.active.delete(child.id)
  await f.stacks.apply(child.id, true)
  expect(f.store.getTask(child.id)?.restackState).toBeUndefined()
})

test('aborts conflicts without losing child commits and accepts a manual or agent repair', async () => {
  const f = await fixture()
  await f.add('parent')
  f.commit('parent', 'source.txt', 'parent v1\n')
  const child = await f.add('child', 'parent')
  f.commit('child', 'source.txt', 'child\n')
  f.commit('parent', 'source.txt', 'parent v2\n')
  const before = git(child.cwd, 'rev-parse', 'HEAD')
  await f.merge('parent')
  expect(f.store.getTask('child')?.restackState).toBe('conflict')
  expect(git(child.cwd, 'rev-parse', 'HEAD')).toBe(before)
  expect(git(child.cwd, 'status', '--porcelain')).toBe('')
  expect(() => requireStackMergeable(f.store, f.store.getTask('child')!)).toThrow('restacking')
  // Resolve by merging the target while retaining both sides' intended result.
  try { git(child.cwd, 'merge', 'main', '--no-edit') } catch { /* Expected conflict. */ }
  writeFileSync(join(child.cwd, 'source.txt'), 'parent v2 and child\n')
  git(child.cwd, 'add', '.')
  git(child.cwd, 'commit', '-m', 'Resolve stack')
  await f.stacks.apply('child')
  expect(f.store.getTask('child')?.restackState).toBeUndefined()
})

test('parent deletion and cancellation retain inherited commits on the project branch base', async () => {
  const f = await fixture()
  await f.add('parent')
  f.commit('parent', 'parent.txt', 'needed\n')
  const child = await f.add('child', 'parent')
  f.commit('child', 'child.txt', 'child\n')
  await f.stacks.restackChildren('parent', true)
  f.store.deleteTaskCascade('parent')
  const updated = f.store.getTask('child')!
  expect(updated.parentTaskId).toBeUndefined()
  expect(updated.restackState).toBeUndefined()
  expect(updated.baseCommit).toBe(git(f.repo, 'rev-parse', 'HEAD'))
  expect(readFileSync(join(child.cwd, 'parent.txt'), 'utf8')).toBe('needed\n')
  const diff = await f.manager.getDiff(f.repo, updated.baseCommit!, updated.headCommit!)
  expect(diff.patch).toContain('parent.txt')
  expect(diff.patch).toContain('child.txt')
})

test('validates cycles, project ownership, cancelled parents and pending restacks', async () => {
  const f = await fixture()
  const parent = await f.add('parent')
  const child = await f.add('child', 'parent')
  expect(() => requireStackParent(f.store, parent, child.id)).toThrow('cycles')
  expect(() => requireStackParent(f.store, { ...child, projectId: 'elsewhere' }, parent.id)).toThrow('same project')
  f.store.updateTask(parent.id, { status: 'cancelled' })
  expect(() => requireStackParent(f.store, child, parent.id)).toThrow('active branch')
})

test('planning unions declared files, suggests actual overlap, and accepts stacking while running', async () => {
  const f = await fixture()
  await f.add('parent')
  f.commit('parent', 'source.txt', 'parent\n')
  const child = await f.add('child')
  const issues = new TaskIssues(f.store)
  issues.initialize(child.id, f.repo)
  callIssueTool(f.store, child.id, child.workspaceId, 'anvil_create_issue', { title: 'Change', description: 'Change source', checklist: ['Check'], validation: 'Test', expectedFiles: ['source.txt', 'next.txt'] })
  issues.finishPlanning(child.id)
  await f.stacks.suggest(child.id)
  expect(f.store.getTask(child.id)?.stackSuggestion).toEqual({ parentTaskId: 'parent', paths: ['source.txt'] })
  expect(f.store.getTask(child.id)?.expectedFiles).toEqual(['source.txt', 'next.txt'])
  f.active.add(child.id)
  await f.stacks.stack(child.id, 'parent')
  expect(f.store.getTask(child.id)?.restackState).toBe('pending')
  f.active.delete(child.id)
  await f.stacks.apply(child.id)
  expect(f.store.getTask(child.id)?.parentTaskId).toBe('parent')
})

test('restacks nested descendants and preserves parent links across restart', async () => {
  const f = await fixture()
  await f.add('parent')
  f.commit('parent', 'parent.txt', 'parent\n')
  await f.add('child', 'parent')
  f.commit('child', 'child.txt', 'child\n')
  await f.add('grandchild', 'child')
  f.commit('grandchild', 'grandchild.txt', 'grandchild\n')
  const reopened = new Store(f.database, options)
  onTestCleanup(() => reopened.close())
  expect(reopened.getTask('grandchild')?.parentTaskId).toBe('child')
  await f.merge('parent')
  expect(f.store.getTask('grandchild')?.restackState).toBeUndefined()
  expect(f.store.getTask('grandchild')?.parentTaskId).toBe('child')
  await f.merge('child')
  expect(f.store.getTask('grandchild')?.parentTaskId).toBeUndefined()
})


test('defers descendants until their running parent has restacked', async () => {
  const f = await fixture()
  await f.add('parent')
  f.commit('parent', 'parent.txt', 'parent\n')
  await f.add('child', 'parent')
  f.commit('child', 'child.txt', 'child\n')
  await f.add('grandchild', 'child')
  f.active.add('child')
  await f.merge('parent')
  const child = f.store.getTask('child')!
  f.store.updateTask('grandchild', { restackState: 'pending', restackTarget: { parentTaskId: 'child', branch: child.branchName!, commit: child.headCommit! } })
  await f.stacks.apply('grandchild')
  expect(f.store.getTask('grandchild')?.restackState).toBe('pending')
  f.active.delete('child')
  await f.stacks.apply('child')
  expect(f.store.getTask('grandchild')?.restackState).toBeUndefined()
})

test('database deletion clears the parent foreign key without deleting the child', async () => {
  const f = await fixture()
  await f.add('parent')
  await f.add('child', 'parent')
  f.store.deleteTaskCascade('parent')
  expect(f.store.getTask('child')?.parentTaskId).toBeUndefined()
  expect(f.store.getTask('child')?.id).toBe('child')
})

test('planning rejects paths outside the repository and preserves declarations when editing an issue', async () => {
  const f = await fixture()
  const task = await f.add('task')
  new TaskIssues(f.store).initialize(task.id, f.repo)
  const input = { title: 'Change', description: 'Change source', checklist: ['Check'], validation: 'Test' }
  const call = (name: string, args: unknown) => callIssueTool(f.store, task.id, task.workspaceId, name, args)
  for (const path of ['../secret', '/absolute', 'C:/secret']) {
    expect(() => call('anvil_create_issue', { ...input, expectedFiles: [path] })).toThrow('repo-relative')
  }
  const issue = call('anvil_create_issue', { ...input, expectedFiles: ['src/source.ts'] }) as { id: string }
  expect(call('anvil_update_issue', { id: issue.id, patch: { title: 'Renamed' } })).toMatchObject({ expectedFiles: ['src/source.ts'] })
})
