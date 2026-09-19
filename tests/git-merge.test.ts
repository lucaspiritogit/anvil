import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm, realpath, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitDeliveryManager } from '../apps/server/src/git'
import { MERGE_CONFLICT_MAX_FILE_BYTES, type TaskMergeConflict } from '@anvil/protocol/types'

test('merges into the current branch while guarding stale previews, local changes and conflicts', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anvil-merge-')))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const repo = join(directory, 'project')
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const manager = new GitDeliveryManager(join(directory, 'worktrees'))
  try {
    await mkdir(repo)
    git('init', '-b', 'main')
    git('config', 'core.autocrlf', 'false')
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
    const conflict = await manager.merge(repo, 'agent/task', conflicting)
    if (conflict.status !== 'conflicted') throw new Error('Expected merge conflicts')
    expect(conflict).toStrictEqual({
      status: 'conflicted',
      repositoryRoot: repo,
      mergeHeadCommit: sourceCommit,
      conflictedFiles: ['shared.txt']
    })
    expect(git('rev-parse', 'HEAD')).toBe(conflictHead)
    expect(git('status', '--porcelain=v1'), 'Content conflicts remain paused').toContain('UU shared.txt')
    expect(await readFile(join(repo, 'shared.txt'), 'utf8')).toContain('<<<<<<< HEAD')
    expect(git('rev-parse', 'agent/task')).toBe(sourceCommit)
    await expect(manager.validateMergeConflict(repo, { ...conflicting, ...conflict })).resolves.toStrictEqual(['shared.txt'])
    await expect(manager.validateMergeConflict(repo, { ...conflicting, ...conflict, repositoryRoot: directory }))
      .rejects.toThrow(/different repository checkout/)
    git('update-ref', 'refs/heads/agent/task', firstCommit)
    await expect(manager.validateMergeConflict(repo, { ...conflicting, ...conflict })).rejects.toThrow(/no longer matches/)
    git('update-ref', 'refs/heads/agent/task', sourceCommit)
    git('update-ref', 'HEAD', baseCommit)
    await expect(manager.validateMergeConflict(repo, { ...conflicting, ...conflict })).rejects.toThrow(/no longer matches/)
    git('update-ref', 'HEAD', conflictHead)
    await writeFile(join(repo, '.git', 'MERGE_HEAD'), `${firstCommit}\n`)
    await expect(manager.validateMergeConflict(repo, { ...conflicting, ...conflict })).rejects.toThrow(/no longer matches/)
    await writeFile(join(repo, '.git', 'MERGE_HEAD'), `${sourceCommit}\n`)
    await expect(manager.validateMergeConflict(repo, { ...conflicting, ...conflict })).resolves.toStrictEqual(['shared.txt'])

    const ownedConflict: TaskMergeConflict = {
      id: 'conflict-session', taskId: 'task', workspaceId: 'default', projectId: 'project',
      repositoryRoot: repo, sourceBranch: conflicting.sourceBranch, targetBranch: conflicting.targetBranch,
      sourceCommit: conflicting.sourceCommit, targetCommit: conflicting.targetCommit,
      mergeHeadCommit: conflict.mergeHeadCommit, conflictedFiles: conflict.conflictedFiles,
      requestedAction: 'merge', createdAt: Date.now()
    }
    const snapshot = await manager.getMergeConflict(repo, ownedConflict)
    expect(snapshot).toMatchObject({ id: ownedConflict.id, taskId: 'task', targetBranch: 'conflicting', canComplete: false })
    expect(snapshot.files).toStrictEqual([{
      path: 'shared.txt', status: 'both_modified', stages: [1, 2, 3], support: 'text',
      contents: expect.stringContaining('<<<<<<< HEAD'), contentsHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    }])
    await expect(manager.completeMergeConflict(repo, ownedConflict)).rejects.toThrow(/Resolve all merge conflicts/)
    await expect(manager.saveMergeConflictFile(repo, ownedConflict, 'shared.txt', 'resolved\n', '0'.repeat(64)))
      .rejects.toThrow(/changed after it was loaded/)
    await expect(manager.saveMergeConflictFile(repo, ownedConflict, '../outside.txt', 'resolved\n', snapshot.files[0].support === 'text' ? snapshot.files[0].contentsHash : ''))
      .rejects.toThrow(/no longer unmerged/)
    const pending = await manager.saveMergeConflictFile(
      repo, ownedConflict, 'shared.txt', '<<<<<<< HEAD\ntarget again\n=======\nsource\n>>>>>>> agent/task\n',
      snapshot.files[0].support === 'text' ? snapshot.files[0].contentsHash : ''
    )
    expect(pending).toMatchObject({ canComplete: false, files: [{ support: 'text' }] })
    expect(git('status', '--porcelain=v1')).toContain('UU shared.txt')
    const refreshedHash = pending.files[0].support === 'text' ? pending.files[0].contentsHash : ''
    const resolved = await manager.saveMergeConflictFile(repo, ownedConflict, 'shared.txt', 'resolved result\n', refreshedHash)
    expect(resolved).toMatchObject({ files: [], canComplete: true })
    expect(git('status', '--porcelain=v1')).toContain('M  shared.txt')
    const completedCommit = await manager.completeMergeConflict(repo, ownedConflict)
    expect(git('rev-parse', 'HEAD')).toBe(completedCommit)
    expect(git('merge-base', '--is-ancestor', sourceCommit, completedCommit)).toBe('')
    expect(git('merge-base', '--is-ancestor', conflictHead, completedCommit)).toBe('')
    await expect(manager.completeMergeConflict(repo, ownedConflict)).resolves.toBe(completedCommit)
    await writeFile(join(repo, 'unfinished.txt'), 'agent left this behind\n')
    await expect(manager.completeMergeConflict(repo, ownedConflict)).rejects.toThrow(/clean completed merge/)
    await rm(join(repo, 'unfinished.txt'))

    git('reset', '--hard', conflictHead)
    const secondConflict = await manager.merge(repo, 'agent/task', conflicting)
    expect(secondConflict.status).toBe('conflicted')
    const abortable: TaskMergeConflict = {
      ...ownedConflict,
      id: 'abort-session',
      mergeHeadCommit: secondConflict.status === 'conflicted' ? secondConflict.mergeHeadCommit : '',
      conflictedFiles: secondConflict.status === 'conflicted' ? secondConflict.conflictedFiles : []
    }

    const conflictStatus = git('status', '--porcelain=v1')
    await expect(manager.merge(repo, 'agent/task', conflicting)).rejects.toThrow(/existing Git operation/)
    expect(git('status', '--porcelain=v1'), 'Pre-existing conflicts are not aborted').toBe(conflictStatus)
    const abortSnapshot = await manager.getMergeConflict(repo, abortable)
    const abortHash = abortSnapshot.files[0].support === 'text' ? abortSnapshot.files[0].contentsHash : ''
    await manager.saveMergeConflictFile(repo, abortable, 'shared.txt', 'partial manual resolution\n', abortHash)
    await manager.abortMergeConflict(repo, abortable)
    expect(git('rev-parse', 'HEAD')).toBe(conflictHead)
    expect(git('status', '--porcelain=v1')).toBe('')
    expect(await readFile(join(repo, 'shared.txt'), 'utf8')).toBe('conflicting user change\n')

    git('checkout', '-b', 'hook-failure', baseCommit)
    await writeFile(join(repo, 'target.txt'), 'target\n')
    git('add', '.')
    git('commit', '-m', 'Diverged target')
    const hookFailureHead = git('rev-parse', 'HEAD')
    const hookFailure = await manager.getMergePreview(repo, 'agent/task')
    const hook = join(repo, '.git', 'hooks', 'pre-merge-commit')
    await writeFile(hook, '#!/bin/sh\nexit 1\n')
    await chmod(hook, 0o755)
    await expect(manager.merge(repo, 'agent/task', hookFailure)).rejects.toThrow(/Merge failed/)
    expect(git('rev-parse', 'HEAD')).toBe(hookFailureHead)
    expect(git('status', '--porcelain=v1'), 'Non-conflict merge failures are aborted').toBe('')
    await rm(hook)

    git('checkout', '--detach')
    await expect(manager.getMergePreview(repo, 'agent/task')).rejects.toThrow(/Check out a branch/)
    git('checkout', 'agent/task')
    await expect(manager.getMergePreview(repo, 'agent/task')).rejects.toThrow(/destination branch/)
    await expect(manager.getMergePreview(repo, 'missing-branch')).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('describes unsupported, add/delete, and rename conflict files without decoding them as text', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anvil-merge-files-')))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const repo = join(directory, 'project')
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const manager = new GitDeliveryManager(join(directory, 'worktrees'))
  try {
    await mkdir(repo)
    git('init', '-b', 'main')
    git('config', 'core.autocrlf', 'false')
    git('config', 'user.name', 'Anvil test')
    git('config', 'user.email', 'anvil-test@example.invalid')
    await writeFile(join(repo, 'binary.dat'), Uint8Array.from([0, 1, 2, 10]))
    await writeFile(join(repo, 'delete.txt'), 'base\n')
    await writeFile(join(repo, 'large.txt'), `base\n${'x'.repeat(MERGE_CONFLICT_MAX_FILE_BYTES)}`)
    const renameBody = Array.from({ length: 20 }, (_, index) => `shared line ${index}\n`).join('')
    await writeFile(join(repo, 'renamed.txt'), `base rename\n${renameBody}`)
    await symlink('base-target', join(repo, 'link'))
    git('add', '.')
    git('commit', '-m', 'Initial files')

    git('checkout', '-b', 'agent/files')
    await writeFile(join(repo, 'binary.dat'), Uint8Array.from([0, 3, 2, 10]))
    await rm(join(repo, 'delete.txt'))
    await writeFile(join(repo, 'large.txt'), `source\n${'x'.repeat(MERGE_CONFLICT_MAX_FILE_BYTES)}`)
    await rm(join(repo, 'link'))
    await symlink('source-target', join(repo, 'link'))
    git('mv', 'renamed.txt', 'source-name.txt')
    await writeFile(join(repo, 'source-name.txt'), `source rename\n${renameBody}`)
    git('add', '-A')
    git('commit', '-m', 'Source conflicts')

    git('checkout', 'main')
    await writeFile(join(repo, 'binary.dat'), Uint8Array.from([0, 4, 2, 10]))
    await writeFile(join(repo, 'delete.txt'), 'target edit\n')
    await writeFile(join(repo, 'large.txt'), `target\n${'x'.repeat(MERGE_CONFLICT_MAX_FILE_BYTES)}`)
    await rm(join(repo, 'link'))
    await symlink('target-target', join(repo, 'link'))
    git('mv', 'renamed.txt', 'target-name.txt')
    await writeFile(join(repo, 'target-name.txt'), `target rename\n${renameBody}`)
    git('add', '-A')
    git('commit', '-m', 'Target conflicts')

    const preview = await manager.getMergePreview(repo, 'agent/files')
    const result = await manager.merge(repo, 'agent/files', preview)
    expect(result.status).toBe('conflicted')
    if (result.status !== 'conflicted') throw new Error('Expected merge conflicts')
    const conflict: TaskMergeConflict = {
      id: 'file-session', taskId: 'task', workspaceId: 'default', projectId: 'project',
      repositoryRoot: repo, sourceBranch: preview.sourceBranch, targetBranch: preview.targetBranch,
      sourceCommit: preview.sourceCommit, targetCommit: preview.targetCommit,
      mergeHeadCommit: result.mergeHeadCommit, conflictedFiles: result.conflictedFiles,
      requestedAction: 'merge', createdAt: Date.now()
    }
    const snapshot = await manager.getMergeConflict(repo, conflict)
    expect(snapshot.files.find((file) => file.path === 'binary.dat')).toMatchObject({
      status: 'both_modified', support: 'unsupported', reason: 'binary'
    })
    expect(snapshot.files.find((file) => file.path === 'large.txt')).toMatchObject({
      status: 'both_modified', support: 'unsupported', reason: 'oversized'
    })
    expect(snapshot.files.find((file) => file.path === 'link')).toMatchObject({
      status: 'both_modified', support: 'unsupported', reason: 'symlink'
    })
    expect(snapshot.files.find((file) => file.path === 'delete.txt')).toMatchObject({
      status: 'deleted_by_them', support: 'text', contents: 'target edit\n'
    })
    const renameFiles = snapshot.files.filter((file) => file.path.includes('name'))
    expect(renameFiles.map((file) => [file.path, file.status])).toEqual(expect.arrayContaining([
      ['renamed.txt', 'both_deleted'],
      ['source-name.txt', 'added_by_them'],
      ['target-name.txt', 'added_by_us']
    ]))
    expect(renameFiles.find((file) => file.path === 'renamed.txt')).toMatchObject({ support: 'unsupported', reason: 'missing' })
    await manager.abortMergeConflict(repo, conflict)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects a conflicted path whose parent is replaced by a symlink escape', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anvil-merge-path-')))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const repo = join(directory, 'project')
  const outside = join(directory, 'outside')
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const manager = new GitDeliveryManager(join(directory, 'worktrees'))
  try {
    await mkdir(join(repo, 'nested'), { recursive: true })
    await mkdir(outside)
    git('init', '-b', 'main')
    git('config', 'user.name', 'Anvil test')
    git('config', 'user.email', 'anvil-test@example.invalid')
    await writeFile(join(repo, 'nested', 'file.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial file')
    git('checkout', '-b', 'agent/path')
    await writeFile(join(repo, 'nested', 'file.txt'), 'source\n')
    git('commit', '-am', 'Source change')
    git('checkout', 'main')
    await writeFile(join(repo, 'nested', 'file.txt'), 'target\n')
    git('commit', '-am', 'Target change')
    const preview = await manager.getMergePreview(repo, 'agent/path')
    const result = await manager.merge(repo, 'agent/path', preview)
    expect(result.status).toBe('conflicted')
    if (result.status !== 'conflicted') throw new Error('Expected merge conflicts')
    const conflict: TaskMergeConflict = {
      id: 'path-session', taskId: 'task', workspaceId: 'default', projectId: 'project',
      repositoryRoot: repo, sourceBranch: preview.sourceBranch, targetBranch: preview.targetBranch,
      sourceCommit: preview.sourceCommit, targetCommit: preview.targetCommit,
      mergeHeadCommit: result.mergeHeadCommit, conflictedFiles: result.conflictedFiles,
      requestedAction: 'merge', createdAt: Date.now()
    }
    await rename(join(repo, 'nested'), join(repo, 'nested-real'))
    await symlink(outside, join(repo, 'nested'), 'dir')
    await expect(manager.getMergeConflict(repo, conflict)).rejects.toThrow(/escapes the repository/)
    await rm(join(repo, 'nested'))
    await rename(join(repo, 'nested-real'), join(repo, 'nested'))
    await manager.abortMergeConflict(repo, conflict)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
