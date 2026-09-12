import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitDeliveryManager } from '../src/server/git'

test('merges into the current branch while guarding stale previews, local changes and conflicts', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anvil-merge-')))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const repo = join(directory, 'project')
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const manager = new GitDeliveryManager(join(directory, 'worktrees'))
  try {
    await mkdir(repo)
    git('init', '-b', 'main')
    git('config', 'user.name', 'Anvil test')
    git('config', 'user.email', 'anvil-test@example.invalid')
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    const baseCommit = git('rev-parse', 'HEAD')
    git('checkout', '-b', 'agent/task')
    await writeFile(join(repo, 'shared.txt'), 'agent\n')
    git('commit', '-am', 'Agent change')
    const firstCommit = git('rev-parse', 'HEAD')
    await writeFile(join(repo, 'new.txt'), 'new\n')
    git('add', '.')
    git('commit', '-m', 'Second agent change')
    const sourceCommit = git('rev-parse', 'HEAD')
    git('checkout', 'main')
    git('checkout', '-b', 'user-current')
    const preview = await manager.getMergePreview(repo, 'agent/task')
    expect(preview).toStrictEqual({
      sourceBranch: 'agent/task', targetBranch: 'user-current', sourceCommit, targetCommit: baseCommit, commitCount: 2
    })
    expect(git('rev-parse', 'HEAD'), 'Preview does not merge').toBe(baseCommit)

    git('checkout', 'main')
    await expect(manager.merge(repo, 'agent/task', preview)).rejects.toThrow(/branches changed/)
    git('checkout', 'user-current')
    git('update-ref', 'refs/heads/agent/task', firstCommit)
    await expect(manager.merge(repo, 'agent/task', preview)).rejects.toThrow(/branches changed/)
    git('update-ref', 'refs/heads/agent/task', sourceCommit)

    await writeFile(join(repo, 'local.txt'), 'untracked work\n')
    await expect(manager.merge(repo, 'agent/task', preview)).rejects.toThrow(/Commit or stash/)
    expect(await readFile(join(repo, 'local.txt'), 'utf8')).toBe('untracked work\n')
    await rm(join(repo, 'local.txt'))
    await writeFile(join(repo, 'shared.txt'), 'staged work\n')
    git('add', '.')
    await writeFile(join(repo, 'shared.txt'), 'unstaged work\n')
    const index = await readFile(join(repo, '.git', 'index'))
    await expect(manager.merge(repo, 'agent/task', preview)).rejects.toThrow(/Commit or stash/)
    expect(await readFile(join(repo, '.git', 'index'))).toStrictEqual(index)
    expect(await readFile(join(repo, 'shared.txt'), 'utf8')).toBe('unstaged work\n')
    git('restore', '--staged', '--worktree', 'shared.txt')

    await manager.merge(repo, 'agent/task', preview)
    expect(git('branch', '--show-current')).toBe('user-current')
    expect(git('rev-parse', 'HEAD'), 'Fast-forward merges the task commits').toBe(sourceCommit)
    expect(git('rev-parse', 'main'), 'Original base branch is not the destination').toBe(baseCommit)
    expect(await readFile(join(repo, 'new.txt'), 'utf8')).toBe('new\n')
    const alreadyMerged = await manager.getMergePreview(repo, 'agent/task')
    expect(alreadyMerged.commitCount).toBe(0)
    await manager.merge(repo, 'agent/task', alreadyMerged)

    git('checkout', '-b', 'diverged', firstCommit)
    await writeFile(join(repo, 'user.txt'), 'user commit\n')
    git('add', '.')
    git('commit', '-m', 'User change')
    await expect(manager.merge(repo, 'agent/task', { ...preview, targetBranch: 'diverged' })).rejects.toThrow(/branches changed/)
    const diverged = await manager.getMergePreview(repo, 'agent/task')
    expect(diverged.commitCount, 'Only commits absent from the current branch count').toBe(1)
    await manager.merge(repo, 'agent/task', diverged)
    expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 'Divergence creates a merge commit').toBe(3)
    expect(await readFile(join(repo, 'user.txt'), 'utf8')).toBe('user commit\n')

    git('checkout', '-b', 'conflicting', baseCommit)
    await writeFile(join(repo, 'shared.txt'), 'conflicting user change\n')
    git('commit', '-am', 'Conflict')
    const conflictHead = git('rev-parse', 'HEAD')
    const conflicting = await manager.getMergePreview(repo, 'agent/task')
    await expect(manager.merge(repo, 'agent/task', conflicting)).rejects.toThrow(/Merge failed/)
    expect(git('rev-parse', 'HEAD')).toBe(conflictHead)
    expect(git('status', '--porcelain=v1'), 'Failed merge is aborted').toBe('')
    expect(await readFile(join(repo, 'shared.txt'), 'utf8')).toBe('conflicting user change\n')
    expect(git('rev-parse', 'agent/task')).toBe(sourceCommit)

    expect(() => git('merge', '--no-edit', 'agent/task')).toThrow()
    const conflictStatus = git('status', '--porcelain=v1')
    await expect(manager.merge(repo, 'agent/task', conflicting)).rejects.toThrow(/existing Git operation/)
    expect(git('status', '--porcelain=v1'), 'Pre-existing conflicts are not aborted').toBe(conflictStatus)
    git('merge', '--abort')
    git('checkout', '--detach')
    await expect(manager.getMergePreview(repo, 'agent/task')).rejects.toThrow(/Check out a branch/)
    git('checkout', 'agent/task')
    await expect(manager.getMergePreview(repo, 'agent/task')).rejects.toThrow(/destination branch/)
    await expect(manager.getMergePreview(repo, 'missing-branch')).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
