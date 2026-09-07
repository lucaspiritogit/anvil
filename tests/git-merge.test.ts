import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitDeliveryManager } from '../src/main/git-delivery'

async function main(): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anvil-merge-')))
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
    assert.deepEqual(preview, {
      sourceBranch: 'agent/task', targetBranch: 'user-current', sourceCommit, targetCommit: baseCommit, commitCount: 2
    })
    assert.equal(git('rev-parse', 'HEAD'), baseCommit, 'Preview does not merge')

    git('checkout', 'main')
    await assert.rejects(manager.merge(repo, 'agent/task', preview), /branches changed/)
    git('checkout', 'user-current')
    git('update-ref', 'refs/heads/agent/task', firstCommit)
    await assert.rejects(manager.merge(repo, 'agent/task', preview), /branches changed/)
    git('update-ref', 'refs/heads/agent/task', sourceCommit)

    await writeFile(join(repo, 'local.txt'), 'untracked work\n')
    await assert.rejects(manager.merge(repo, 'agent/task', preview), /Commit or stash/)
    assert.equal(await readFile(join(repo, 'local.txt'), 'utf8'), 'untracked work\n')
    await rm(join(repo, 'local.txt'))
    await writeFile(join(repo, 'shared.txt'), 'staged work\n')
    git('add', '.')
    await writeFile(join(repo, 'shared.txt'), 'unstaged work\n')
    const index = await readFile(join(repo, '.git', 'index'))
    await assert.rejects(manager.merge(repo, 'agent/task', preview), /Commit or stash/)
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), index)
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'unstaged work\n')
    git('restore', '--staged', '--worktree', 'shared.txt')

    await manager.merge(repo, 'agent/task', preview)
    assert.equal(git('branch', '--show-current'), 'user-current')
    assert.equal(git('rev-parse', 'HEAD'), sourceCommit, 'Fast-forward merges the task commits')
    assert.equal(git('rev-parse', 'main'), baseCommit, 'Original base branch is not the destination')
    assert.equal(await readFile(join(repo, 'new.txt'), 'utf8'), 'new\n')
    const alreadyMerged = await manager.getMergePreview(repo, 'agent/task')
    assert.equal(alreadyMerged.commitCount, 0)
    await manager.merge(repo, 'agent/task', alreadyMerged)

    git('checkout', '-b', 'diverged', firstCommit)
    await writeFile(join(repo, 'user.txt'), 'user commit\n')
    git('add', '.')
    git('commit', '-m', 'User change')
    await assert.rejects(manager.merge(repo, 'agent/task', { ...preview, targetBranch: 'diverged' }), /branches changed/)
    const diverged = await manager.getMergePreview(repo, 'agent/task')
    assert.equal(diverged.commitCount, 1, 'Only commits absent from the current branch count')
    await manager.merge(repo, 'agent/task', diverged)
    assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'Divergence creates a merge commit')
    assert.equal(await readFile(join(repo, 'user.txt'), 'utf8'), 'user commit\n')

    git('checkout', '-b', 'conflicting', baseCommit)
    await writeFile(join(repo, 'shared.txt'), 'conflicting user change\n')
    git('commit', '-am', 'Conflict')
    const conflictHead = git('rev-parse', 'HEAD')
    const conflicting = await manager.getMergePreview(repo, 'agent/task')
    await assert.rejects(manager.merge(repo, 'agent/task', conflicting), /Merge failed/)
    assert.equal(git('rev-parse', 'HEAD'), conflictHead)
    assert.equal(git('status', '--porcelain=v1'), '', 'Failed merge is aborted')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'conflicting user change\n')
    assert.equal(git('rev-parse', 'agent/task'), sourceCommit)

    assert.throws(() => git('merge', '--no-edit', 'agent/task'))
    const conflictStatus = git('status', '--porcelain=v1')
    await assert.rejects(manager.merge(repo, 'agent/task', conflicting), /existing Git operation/)
    assert.equal(git('status', '--porcelain=v1'), conflictStatus, 'Pre-existing conflicts are not aborted')
    git('merge', '--abort')
    git('checkout', '--detach')
    await assert.rejects(manager.getMergePreview(repo, 'agent/task'), /Check out a branch/)
    git('checkout', 'agent/task')
    await assert.rejects(manager.getMergePreview(repo, 'agent/task'), /destination branch/)
    await assert.rejects(manager.getMergePreview(repo, 'missing-branch'))
    console.log('Git merge passed: current checkout, commit counts, stale previews, local changes, fast-forward, merge commits, conflicts, and detached HEAD.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
