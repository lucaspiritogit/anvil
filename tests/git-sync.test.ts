import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitDeliveryManager } from '../apps/server/src/git'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anvil-git-sync-')))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const origin = join(directory, 'origin.git')
  const repo = join(directory, 'project')
  const other = join(directory, 'other')
  git(directory, 'init', '--bare', '-b', 'main', origin)
  for (const checkout of [repo, other]) {
    git(directory, 'clone', '-q', origin, checkout)
    git(checkout, 'config', 'user.name', 'Anvil test')
    git(checkout, 'config', 'user.email', 'anvil-test@example.invalid')
    git(checkout, 'config', 'core.autocrlf', 'false')
  }
  await writeFile(join(repo, 'source.ts'), 'base\n')
  await writeFile(join(repo, 'shared.ts'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'Base')
  git(repo, 'push', '-q', 'origin', 'main')
  git(other, 'pull', '-q', 'origin', 'main')
  const pushFromOther = async (file: string, contents: string) => {
    await writeFile(join(other, file), contents)
    git(other, 'commit', '-q', '-am', `Change ${file}`)
    git(other, 'push', '-q', 'origin', 'main')
  }
  return { repo, other, manager: new GitDeliveryManager(join(directory, 'worktrees')), pushFromOther }
}

test('reports an up-to-date branch and a branch missing from origin', async () => {
  const { repo, manager } = await fixture()
  const head = git(repo, 'rev-parse', 'HEAD')

  expect(await manager.getSyncStatus(repo)).toEqual({ branch: 'main', localCommit: head, remoteCommit: head, ahead: 0, behind: 0, overlappingPaths: [] })

  git(repo, 'switch', '-q', '-c', 'feature')
  expect(await manager.getSyncStatus(repo)).toMatchObject({ branch: 'feature', remoteCommit: null, ahead: 0, behind: 0 })
})

test('fetches new origin commits and fast-forwards while keeping unrelated local changes', async () => {
  const { repo, other, manager, pushFromOther } = await fixture()
  await pushFromOther('shared.ts', 'remote\n')
  await writeFile(join(repo, 'source.ts'), 'local\n')

  const status = await manager.getSyncStatus(repo)
  expect(status).toMatchObject({ branch: 'main', remoteCommit: git(other, 'rev-parse', 'HEAD'), ahead: 0, behind: 1, overlappingPaths: [] })
  expect(git(repo, 'rev-parse', 'origin/main')).toBe(status.remoteCommit)

  const pulled = await manager.pull(repo, { branch: status.branch, localCommit: status.localCommit, remoteCommit: status.remoteCommit! })

  expect(pulled).toMatchObject({ localCommit: status.remoteCommit, behind: 0 })
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(status.remoteCommit)
  expect(await readFile(join(repo, 'shared.ts'), 'utf8')).toBe('remote\n')
  expect(await readFile(join(repo, 'source.ts'), 'utf8')).toBe('local\n')
})

test('reports overlapping and diverged changes and refuses stale or unsafe pulls', async () => {
  const { repo, manager, pushFromOther } = await fixture()
  await pushFromOther('shared.ts', 'remote\n')
  await writeFile(join(repo, 'shared.ts'), 'local\n')

  const overlapping = await manager.getSyncStatus(repo)
  expect(overlapping).toMatchObject({ behind: 1, overlappingPaths: ['shared.ts'] })
  const target = { branch: 'main', localCommit: overlapping.localCommit, remoteCommit: overlapping.remoteCommit! }
  await expect(manager.pull(repo, target)).rejects.toThrow(/Could not fast-forward main/)
  expect(await readFile(join(repo, 'shared.ts'), 'utf8')).toBe('local\n')

  git(repo, 'commit', '-q', '-am', 'Local change')
  await expect(manager.pull(repo, target)).rejects.toThrow(/checked-out branch changed/)
  const diverged = await manager.getSyncStatus(repo)
  expect(diverged).toMatchObject({ ahead: 1, behind: 1, overlappingPaths: [] })
  await expect(manager.pull(repo, { branch: 'main', localCommit: diverged.localCommit, remoteCommit: diverged.remoteCommit! }))
    .rejects.toThrow(/local commits that are not on origin\/main/)
})
