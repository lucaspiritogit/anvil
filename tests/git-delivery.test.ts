import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitDeliveryManager, type PreparedCheckout } from '../src/main/git-delivery'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function fixture(initialCommit = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anvil-git-delivery-')))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const repo = join(directory, 'project')
  const worktrees = join(directory, 'worktrees')
  await mkdir(join(repo, 'app'), { recursive: true })
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Anvil test')
  git(repo, 'config', 'user.email', 'anvil-test@example.invalid')
  // Fixture contents must not depend on the developer's global checkout settings.
  git(repo, 'config', 'core.autocrlf', 'false')
  if (initialCommit) {
    await writeFile(join(repo, 'app', 'source.ts'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Base')
  }
  const manager = new GitDeliveryManager(worktrees)
  const finish = (id: string, task: PreparedCheckout) => manager.finalizeBranch(repo, id, task.branchName, task.baseBranch, task.baseCommit, 'Task changes')
  return { directory, repo, worktrees, manager, finish }
}

for (const staged of [false, true]) {
  test(`initializes an empty repository without copying or committing ${staged ? 'staged' : 'untracked'} project files`, async () => {
    const { repo, manager, finish } = await fixture(false)
    await writeFile(join(repo, '.env'), 'SECRET=test\n')
    if (staged) git(repo, 'add', '.')
    const status = git(repo, 'status', '--porcelain=v1')
    const index = staged ? await readFile(join(repo, '.git', 'index')) : undefined
    const task = await manager.prepareBranch(repo, 'empty', 'Empty task')
    expect(task.initializedRepository).toBe(true)
    expect(git(repo, 'ls-tree', '-r', 'HEAD')).toBe('')
    expect(existsSync(join(task.cwd, '.env'))).toBe(false)
    expect(git(repo, 'status', '--porcelain=v1')).toBe(status)
    if (index) expect(await readFile(join(repo, '.git', 'index'))).toStrictEqual(index)
    expect((await finish('empty', task)).hasChanges).toBe(false)
    expect(git(repo, 'branch', '--show-current')).toBe('main')
  })
}

test('parallel tasks use independent branches and worktrees through nested and symlinked project paths', async () => {
  const { repo, directory, manager, finish } = await fixture()
  const alias = join(directory, 'alias')
  await symlink(repo, alias, 'junction')
  await writeFile(join(repo, 'app', 'source.ts'), 'staged project work\n')
  git(repo, 'add', '.')
  await writeFile(join(repo, 'app', 'source.ts'), 'unstaged project work\n')
  await writeFile(join(repo, 'local.txt'), 'untracked project work\n')
  const index = await readFile(join(repo, '.git', 'index'))
  const [one, two] = await Promise.all([
    manager.prepareBranch(repo, 'one', 'Task'),
    manager.prepareBranch(join(alias, 'app'), 'two', 'Task')
  ])
  expect(one.cwd).not.toBe(two.cwd)
  expect(one.baseCommit).toBe(two.baseCommit)
  expect(git(repo, 'branch', '--show-current')).toBe('main')
  expect(git(one.cwd, 'branch', '--show-current')).toBe(one.branchName)
  expect(git(two.cwd, 'branch', '--show-current')).toBe(two.branchName)
  expect(await readFile(join(two.cwd, 'source.ts'), 'utf8')).toBe('base\n')
  await writeFile(join(one.cwd, 'app', 'source.ts'), 'task one\n')
  await writeFile(join(two.cwd, 'source.ts'), 'task two\n')
  expect((await manager.getMergePreview(repo, one.branchName)).targetBranch).toBe('main')
  const [first, second] = await Promise.all([finish('one', one), finish('two', two)])
  expect((await manager.getDiff(repo, one.baseCommit, first.headCommit)).patch).toContain('+task one')
  expect((await manager.getDiff(repo, two.baseCommit, second.headCommit)).patch).toContain('+task two')
  expect(git(repo, 'show', `${first.headCommit}:app/source.ts`)).toBe('task one')
  expect(git(repo, 'show', `${second.headCommit}:app/source.ts`)).toBe('task two')
  expect(await readFile(join(repo, '.git', 'index'))).toStrictEqual(index)
  expect(await readFile(join(repo, 'app', 'source.ts'), 'utf8')).toBe('unstaged project work\n')
  expect(await readFile(join(repo, 'local.txt'), 'utf8')).toBe('untracked project work\n')
  expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(3)
})

test('restart preserves unfinished work and follow-ups retain the cumulative diff and rebase', async () => {
  const { repo, manager, worktrees } = await fixture()
  const task = await manager.prepareBranch(repo, 'resume', 'Task')
  await writeFile(join(task.cwd, 'app', 'source.ts'), 'interrupted change\n')
  const restarted = new GitDeliveryManager(worktrees)
  const resumed = await restarted.checkoutBranch(repo, 'resume', task.branchName, task.baseBranch)
  expect(resumed.cwd).toBe(task.cwd)
  expect(await readFile(join(resumed.cwd, 'app', 'source.ts'), 'utf8')).toBe('interrupted change\n')
  const first = await restarted.finalizeBranch(repo, 'resume', task.branchName, task.baseBranch, task.baseCommit, 'First')
  expect(first.finisherCommitted).toBe(true)
  const followup = await restarted.checkoutBranch(repo, 'resume', task.branchName, task.baseBranch)
  await writeFile(join(followup.cwd, 'followup.txt'), 'review change\n')
  const second = await restarted.finalizeBranch(repo, 'resume', task.branchName, task.baseBranch, task.baseCommit, 'Second')
  const commits = (await restarted.getDiff(repo, task.baseCommit, second.headCommit)).commits.reverse()
  expect(commits).toHaveLength(2)
  const rebased = await restarted.rebase(repo, 'resume', task.branchName, task.baseCommit, [
    { sha: commits[0].sha, action: 'pick', message: 'Combined task' },
    { sha: commits[1].sha, action: 'squash', message: '' }
  ])
  expect(rebased.commits).toHaveLength(1)
  expect(git(repo, 'diff', second.headCommit, rebased.headCommit)).toBe('')
  expect(git(repo, 'branch', '--show-current')).toBe('main')
})

test('per-issue diff uses the recorded range and falls back to the task diff for legacy issues', async () => {
  const { repo, manager } = await fixture()
  const task = await manager.prepareBranch(repo, 'ranges', 'Ranges')
  await writeFile(join(task.cwd, 'one.txt'), 'one\n')
  git(task.cwd, 'add', 'one.txt')
  git(task.cwd, 'commit', '-m', 'feat: one')
  const firstHead = git(task.cwd, 'rev-parse', 'HEAD')
  await writeFile(join(task.cwd, 'two.txt'), 'two\n')
  git(task.cwd, 'add', 'two.txt')
  git(task.cwd, 'commit', '-m', 'feat: two')
  const taskHead = git(task.cwd, 'rev-parse', 'HEAD')
  expect(manager.worktreeHead('ranges')).toBe(taskHead)
  expect(manager.worktreeHead('missing-worktree')).toBeNull()

  const perIssue = await manager.getIssueDiff(repo, {
    baseCommit: task.baseCommit, headCommit: firstHead,
    taskBaseCommit: task.baseCommit, taskHeadCommit: taskHead
  })
  expect(perIssue?.patch).toContain('one.txt')
  expect(perIssue?.patch).not.toContain('two.txt')
  expect(perIssue?.commits.map(({ subject }) => subject)).toEqual(['feat: one'])

  const legacy = await manager.getIssueDiff(repo, { taskBaseCommit: task.baseCommit, taskHeadCommit: taskHead })
  expect(legacy?.patch).toContain('one.txt')
  expect(legacy?.patch).toContain('two.txt')
  expect(legacy?.commits).toHaveLength(2)

  expect(await manager.getIssueDiff(repo, {})).toBeNull()
  expect(await manager.getIssueDiff(repo, { baseCommit: task.baseCommit })).toBeNull()
  await manager.releaseWorktree('ranges')
})

test('project branch selection changes the next task base without affecting running tasks', async () => {
  const { repo, manager, finish } = await fixture()
  git(repo, 'switch', '-c', 'feature')
  await writeFile(join(repo, 'app', 'source.ts'), 'feature base\n')
  git(repo, 'commit', '-am', 'Feature base')
  const featureCommit = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'switch', 'main')
  const one = await manager.prepareBranch(repo, 'one', 'Task')
  const branches = await manager.branches(repo)
  expect(branches.currentBranch).toBe('main')
  expect(branches.branches).toContainEqual({ name: one.branchName, checkedOut: true })
  expect((await manager.switchProjectBranch(repo, 'feature')).currentBranch).toBe('feature')
  expect(git(one.cwd, 'rev-parse', 'HEAD')).toBe(one.baseCommit)
  const two = await manager.prepareBranch(repo, 'two', 'Task')
  expect(two.baseBranch).toBe('feature')
  expect(two.baseCommit).toBe(featureCommit)
  await expect(manager.switchProjectBranch(repo, one.branchName)).rejects.toThrow()
  await expect(manager.switchProjectBranch(repo, '--detach')).rejects.toThrow()
  await expect(manager.switchProjectBranch(repo, 'missing')).rejects.toThrow()
  await writeFile(join(repo, 'app', 'source.ts'), 'local changes\n')
  await expect(manager.switchProjectBranch(repo, 'main')).rejects.toThrow()
  expect(await readFile(join(repo, 'app', 'source.ts'), 'utf8')).toBe('local changes\n')
  await finish('one', one)
  await finish('two', two)
  expect(git(repo, 'branch', '--show-current')).toBe('feature')
})

test('failed delivery preserves files until task deletion', async () => {
  const { repo, manager, finish } = await fixture()
  const task = await manager.prepareBranch(repo, 'dirty', 'Task')
  await writeFile(join(task.cwd, 'unfinished.txt'), 'keep me\n')
  expect(await readFile(join(task.cwd, 'unfinished.txt'), 'utf8')).toBe('keep me\n')
  git(task.cwd, 'switch', '-c', 'unexpected')
  await expect(finish('dirty', task)).rejects.toThrow(/switched away/)
  expect(await readFile(join(task.cwd, 'unfinished.txt'), 'utf8')).toBe('keep me\n')
  await expect(manager.checkoutBranch(repo, 'dirty', task.branchName, task.baseBranch)).rejects.toThrow(/switched away/)
  await expect(manager.prepareBranch(repo, '../escape', 'Task')).rejects.toThrow(/Invalid task ID/)
  await manager.releaseWorktree('dirty')
  expect(existsSync(task.cwd)).toBe(false)
})

test('cancellation between staging and committing preserves the uncommitted task files', async () => {
  const { repo, manager } = await fixture()
  const task = await manager.prepareBranch(repo, 'cancel-finisher', 'Task')
  await writeFile(join(task.cwd, 'unfinished.txt'), 'keep me\n')
  let cancelled = false
  await expect(manager.finalizeBranch(repo, 'cancel-finisher', task.branchName, task.baseBranch, task.baseCommit, 'Task', {
    onFinisherCommand: (command) => { if (command.includes('commit')) cancelled = true },
    check: () => { if (cancelled) throw new Error('Cancelled') }
  })).rejects.toThrow('Cancelled')
  expect(git(task.cwd, 'rev-parse', 'HEAD')).toBe(task.baseCommit)
  expect(git(task.cwd, 'diff', '--cached', '--name-only')).toBe('unfinished.txt')
})

test('rejects a successful commit whose hook leaves additional uncommitted files', async () => {
  const { repo, manager, finish } = await fixture()
  const task = await manager.prepareBranch(repo, 'dirty-hook', 'Task')
  await writeFile(join(task.cwd, 'source.txt'), 'change\n')
  await writeFile(join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\nprintf "generated\\n" > generated.txt\n', { mode: 0o755 })
  await expect(finish('dirty-hook', task)).rejects.toThrow(/still has uncommitted changes/)
  expect(git(task.cwd, 'rev-parse', 'HEAD')).not.toBe(task.baseCommit)
  expect(await readFile(join(task.cwd, 'generated.txt'), 'utf8')).toBe('generated\n')
})

test('legacy tasks migrate from a clean project checkout and preserve dirty legacy files', async () => {
  const { repo, manager } = await fixture()
  git(repo, 'switch', '-c', 'legacy-task')
  await writeFile(join(repo, 'unfinished.txt'), 'legacy work\n')
  await expect(manager.checkoutBranch(repo, 'legacy', 'legacy-task', 'main')).rejects.toThrow(/older task/)
  expect(await readFile(join(repo, 'unfinished.txt'), 'utf8')).toBe('legacy work\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Saved work')
  const task = await manager.checkoutBranch(repo, 'legacy', 'legacy-task', 'main')
  expect(git(repo, 'branch', '--show-current')).toBe('main')
  expect(await readFile(join(task.cwd, 'unfinished.txt'), 'utf8')).toBe('legacy work\n')
})

test('ignored task files survive finalization, restart and manual rebase', async () => {
  const { repo, manager, finish, worktrees } = await fixture()
  const task = await manager.prepareBranch(repo, 'ignored', 'Task')
  await writeFile(join(task.cwd, '.gitignore'), 'local.env\n')
  await writeFile(join(task.cwd, 'local.env'), 'KEEP=task-local\n')
  const first = await finish('ignored', task)
  expect(await readFile(join(task.cwd, 'local.env'), 'utf8')).toBe('KEEP=task-local\n')
  const restarted = new GitDeliveryManager(worktrees)
  expect((await restarted.checkoutBranch(repo, 'ignored', task.branchName, task.baseBranch)).cwd).toBe(task.cwd)
  const commits = (await restarted.getDiff(repo, task.baseCommit, first.headCommit)).commits
  const result = await restarted.rebase(repo, 'ignored', task.branchName, task.baseCommit, [
    { sha: commits[0].sha, action: 'pick', message: 'Reworded' }
  ])
  expect(result.commits[0].subject).toBe('Reworded')
  expect(await readFile(join(task.cwd, 'local.env'), 'utf8')).toBe('KEEP=task-local\n')
  await restarted.releaseWorktree('ignored')
  expect(existsSync(task.cwd)).toBe(false)
})
