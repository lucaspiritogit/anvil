import { expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestCleanup } from './test-cleanup'
import { GitDeliveryManager } from '../apps/server/src/git'

function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-ship-squash-')))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-b', 'main', repo])
  git('config', 'user.name', 'Anvil test')
  git('config', 'user.email', 'anvil-test@example.invalid')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'Base')
  git('checkout', '-b', 'task')
  writeFileSync(join(repo, 'one.txt'), 'one\n')
  git('add', '.')
  git('commit', '-m', 'wip: one')
  writeFileSync(join(repo, 'two.txt'), 'two\n')
  git('add', '.')
  git('commit', '-m', 'wip: two')
  git('checkout', 'main')
  return { repo, git, delivery: new GitDeliveryManager(join(root, 'worktrees')) }
}

async function ship(delivery: GitDeliveryManager, repo: string, message: string) {
  const preview = await delivery.getMergePreview(repo, 'task')
  const result = await delivery.merge(repo, 'task', preview)
  if (result.status !== 'merged') throw new Error('Expected a clean merge')
  const shipped = await delivery.squashMergedCommit(repo, {
    targetBranch: preview.targetBranch, targetCommit: preview.targetCommit, mergedCommit: result.commit
  }, message)
  return { preview, mergedCommit: result.commit, shipped }
}

test('squashes a fast-forward task branch into one commit on the target branch', async () => {
  const { repo, git, delivery } = repository()
  const { preview, shipped } = await ship(delivery, repo, 'feat: add one and two\n\nBoth files ship together.')

  expect(git('rev-parse', 'main')).toBe(shipped)
  expect(git('rev-list', '--parents', '-n', '1', shipped).split(' ')).toEqual([shipped, preview.targetCommit])
  expect(git('log', '-1', '--format=%B', shipped)).toBe('feat: add one and two\n\nBoth files ship together.')
  expect(git('rev-parse', `${shipped}^{tree}`)).toBe(git('rev-parse', 'task^{tree}'))
  expect(git('status', '--porcelain')).toBe('')
})

test('squashes a real merge when the target branch moved ahead of the task base', async () => {
  const { repo, git, delivery } = repository()
  writeFileSync(join(repo, 'main.txt'), 'main\n')
  git('add', '.')
  git('commit', '-m', 'Main moved')
  const { preview, mergedCommit, shipped } = await ship(delivery, repo, 'feat: ship task')

  expect(mergedCommit).not.toBe(shipped)
  expect(git('rev-list', '--parents', '-n', '1', shipped).split(' ')).toEqual([shipped, preview.targetCommit])
  expect(git('ls-tree', '--name-only', shipped).split('\n').sort()).toEqual(['base.txt', 'main.txt', 'one.txt', 'two.txt'])
  expect(git('rev-list', '--count', `${preview.targetCommit}..main`)).toBe('1')
  expect(git('status', '--porcelain')).toBe('')
})

test('refuses to squash when the target branch moved after the merge', async () => {
  const { repo, git, delivery } = repository()
  const preview = await delivery.getMergePreview(repo, 'task')
  const result = await delivery.merge(repo, 'task', preview)
  if (result.status !== 'merged') throw new Error('Expected a clean merge')
  writeFileSync(join(repo, 'late.txt'), 'late\n')
  git('add', '.')
  git('commit', '-m', 'Late commit')

  await expect(delivery.squashMergedCommit(repo, {
    targetBranch: preview.targetBranch, targetCommit: preview.targetCommit, mergedCommit: result.commit
  }, 'feat: ship task')).rejects.toThrow(/moved after the merge/)
})
