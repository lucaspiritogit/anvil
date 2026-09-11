import { expect, test, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { taskBranchNaming, temporaryTaskBranch } from '../src/main/tasks/task-branch'
import { cancelTaskOperation } from '../src/main/tasks/operations'
import { taskBranchFixture, branchGit as git } from './task-branch-fixture'
import { onTestCleanup } from './test-cleanup'

test('names once, serializes retries, keeps task identity and persists across reopening', async () => {
  // Keep elapsed work stable while comparing the task before and after renaming.
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const f = await taskBranchFixture()
  expect(taskBranchNaming(f.task)).toEqual({ branchName: temporaryTaskBranch(f.task.id), canNameBranch: true })
  writeFileSync(join(f.task.cwd, 'dirty.txt'), 'Keep this work')
  const head = git(f.task.cwd, 'rev-parse', 'HEAD')
  const results = await Promise.all([f.set(), f.set()])
  expect(results).toEqual(Array(2).fill({ branchName: 'feat/task-owned-name', canNameBranch: false }))
  await expect(f.set('feat/different')).rejects.toThrow('established')
  expect(f.store.getTask(f.task.id)).toMatchObject({ ...f.task, branchName: 'feat/task-owned-name' })
  expect(git(f.task.cwd, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(f.task.cwd, 'status', '--porcelain')).toBe('?? dirty.txt')
  expect(git(f.repo, 'branch', '--show-current')).toBe('main')
  expect(f.send).toHaveBeenCalledWith('task:updated', expect.objectContaining({ id: f.task.id, branchName: 'feat/task-owned-name' }))
  const reopened = new Store(f.database, f.options)
  onTestCleanup(() => reopened.close())
  expect(reopened.getTask(f.task.id)?.branchName).toBe('feat/task-owned-name')
  expect((await f.manager.checkoutBranch(f.repo, f.task.id, reopened.getTask(f.task.id)!.branchName!)).cwd).toBe(f.task.cwd)
})

test('rejects malformed, reserved, colliding, established, foreign and unavailable branches', async () => {
  const f = await taskBranchFixture()
  for (const name of ['', ' padded ', 'bad name', 'main', 'HEAD', 'refs/heads/name', temporaryTaskBranch('other')]) await expect(f.set(name)).rejects.toThrow()
  await expect(f.branches.set(f.task.id, 'foreign-workspace', 'feat/name', () => {})).rejects.toThrow('owning workspace')
  await expect(f.branches.set('missing-task', f.task.workspaceId, 'feat/name', () => {})).rejects.toThrow('not found')
  for (const patch of [
    { status: 'cancelled' as const }, { status: 'succeeded' as const }, { deliveryStatus: 'finalizing' as const },
    { settledAt: 1 }, { restackState: 'pending' as const }, { branchName: undefined }, { baseCommit: undefined }
  ]) {
    f.store.updateTask(f.task.id, patch)
    expect(taskBranchNaming(f.store.getTask(f.task.id)!).canNameBranch).toBe(false)
    await expect(f.set()).rejects.toThrow(/unavailable|established/)
    f.store.updateTask(f.task.id, { ...f.task, settledAt: undefined, restackState: undefined })
  }
  git(f.task.cwd, 'branch', '-m', 'legacy-name')
  f.store.updateTask(f.task.id, { branchName: 'legacy-name' })
  await expect(f.set()).rejects.toThrow('established')
  expect(await f.set('legacy-name')).toEqual({ branchName: 'legacy-name', canNameBranch: false })
})

test('two competing proposals accept only the first', async () => {
  const f = await taskBranchFixture()
  const results = await Promise.allSettled([f.set('feat/first'), f.set('feat/second')])
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(git(f.task.cwd, 'branch', '--show-current')).toBe(f.store.getTask(f.task.id)?.branchName)
})

for (const interruption of ['expiry', 'cancel', 'delete'] as const) {
  test(`checks ${interruption} again after waiting for the repository lock`, async () => {
    const f = await taskBranchFixture()
    let expire = false
    let entered!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const hold = new Promise<void>((resolve) => { release = resolve })
    const lock = f.manager.withRepoLock(f.repo, async () => { entered(); await hold })
    await ready
    const rename = vi.spyOn(f.manager, 'renameTaskBranch')
    const result = f.set(undefined, () => { if (expire) throw new Error('Turn expired') })
    const assertion = expect(result).rejects.toThrow(/expired|cancelled|deleted/)
    await vi.waitFor(() => expect(rename).toHaveBeenCalled())
    if (interruption === 'expiry') expire = true
    if (interruption === 'cancel') expect(cancelTaskOperation(f.store, f.task.id)).toBe(true)
    if (interruption === 'delete') f.store.deleteTaskCascade(f.task.id)
    release()
    await lock
    await assertion
    expect(git(f.task.cwd, 'branch', '--show-current')).toBe(f.task.branchName)
    expect(f.send).not.toHaveBeenCalled()
  })
}

test('a successful Git rename with a failed Store transaction restores Git and permits retry', async () => {
  const f = await taskBranchFixture()
  const update = f.store.updateTask.bind(f.store)
  vi.spyOn(f.store, 'updateTask').mockImplementationOnce((id, patch) => {
    expect(git(f.task.cwd, 'branch', '--show-current')).toBe('feat/task-owned-name')
    update(id, patch)
    throw new Error('Database write failed')
  })
  await expect(f.set()).rejects.toThrow('Database write failed')
  expect(f.store.getTask(f.task.id)?.branchName).toBe(f.task.branchName)
  expect(git(f.task.cwd, 'branch', '--show-current')).toBe(f.task.branchName)
  expect(f.send).not.toHaveBeenCalled()
  expect((await f.set()).branchName).toBe('feat/task-owned-name')
})

test('reconciles the accepted name if restoring Git fails after a transient Store failure', async () => {
  const f = await taskBranchFixture()
  vi.spyOn(f.store, 'updateTask').mockImplementationOnce(() => {
    // A concurrent external Git user takes the old name; rollback must not force it.
    git(f.repo, 'branch', f.task.branchName!, 'HEAD')
    throw new Error('Transient database failure')
  })
  expect((await f.set()).branchName).toBe('feat/task-owned-name')
  expect(f.store.getTask(f.task.id)?.branchName).toBe(git(f.task.cwd, 'branch', '--show-current'))
  expect(git(f.repo, 'rev-parse', f.task.branchName!)).toBe(f.task.baseCommit)
})

for (const interruption of ['expiry', 'cancel', 'delete'] as const) {
  test(`reconciles ${interruption} after Git mutation without restoring stale lifecycle state`, async () => {
    const f = await taskBranchFixture()
    let expired = false
    const rename = f.manager.renameTaskBranch.bind(f.manager)
    vi.spyOn(f.manager, 'renameTaskBranch').mockImplementation((project, id, branch, proposed, check, save) =>
      rename(project, id, branch, proposed, check, (accepted) => {
        expired = true
        if (interruption === 'cancel') f.store.updateTask(id, { status: 'cancelled' })
        if (interruption === 'delete') f.store.deleteTaskCascade(id)
        save!(accepted)
      }))
    const result = f.set(undefined, () => { if (expired) throw new Error('Turn expired') })
    if (interruption === 'delete') {
      await expect(result).rejects.toThrow('deleted')
      expect(f.store.getTask(f.task.id)).toBeUndefined()
      expect(git(f.task.cwd, 'branch', '--show-current')).toBe(f.task.branchName)
    } else {
      await result
      expect(f.store.getTask(f.task.id)).toMatchObject({ branchName: 'feat/task-owned-name', status: interruption === 'cancel' ? 'cancelled' : 'running' })
      expect(git(f.task.cwd, 'branch', '--show-current')).toBe('feat/task-owned-name')
    }
  })
}
