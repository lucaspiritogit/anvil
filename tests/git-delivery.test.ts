import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitDeliveryManager } from '../src/main/git-delivery'

async function main(): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anvil-worktree-')))
  const repo = join(directory, 'project')
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  try {
    await mkdir(repo)
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.name', 'Anvil test')
    git(repo, 'config', 'user.email', 'anvil-test@example.invalid')
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n.env\n')
    await mkdir(join(repo, 'app'))
    await writeFile(join(repo, 'app', 'source.ts'), 'nested project\n')
    await writeFile(join(repo, 'composer.ts'), 'committed composer\n')
    await writeFile(join(repo, 'deleted.txt'), 'delete me\n')
    git(repo, 'add', '--all')
    git(repo, 'commit', '-m', 'Initial commit')
    const originalHead = git(repo, 'rev-parse', 'HEAD')
    await writeFile(join(repo, 'composer.ts'), 'staged composer\n')
    git(repo, 'add', 'composer.ts')
    await writeFile(join(repo, 'composer.ts'), 'current composer\n')
    await rm(join(repo, 'deleted.txt'))
    await mkdir(join(repo, 'public'))
    await writeFile(join(repo, 'public', 'openai.svg'), '<svg>existing icon</svg>\n')
    await writeFile(join(repo, '.env'), 'DO_NOT_COPY=test\n')
    const originalIndex = await readFile(join(repo, '.git', 'index'))
    const originalStatus = git(repo, 'status', '--porcelain=v1')
    const manager = new GitDeliveryManager(join(directory, 'worktrees'))
    const [first, second] = await Promise.all([
      manager.prepare(repo, 'same-prefix-one', 'Fix icon'),
      manager.prepare(repo, 'same-prefix-two', 'Fix icon')
    ])
    assert.equal(await readFile(join(first.cwd, 'composer.ts'), 'utf8'), 'current composer\n', 'Tasks must see the current composer, not stale HEAD')
    assert.equal(await readFile(join(first.cwd, 'public', 'openai.svg'), 'utf8'), '<svg>existing icon</svg>\n')
    await assert.rejects(readFile(join(first.cwd, '.env')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(first.cwd, 'deleted.txt')), { code: 'ENOENT' })
    assert.notEqual(first.cwd, second.cwd)
    assert.notEqual(first.branchName, second.branchName)
    assert.equal(git(first.cwd, 'status', '--porcelain=v1'), '')
    assert.equal(git(repo, 'rev-parse', 'HEAD'), originalHead)
    assert.equal(git(repo, 'branch', '--show-current'), 'main')
    assert.equal(git(repo, 'status', '--porcelain=v1'), originalStatus)
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), originalIndex, 'Preparation must not touch the user index')
    await writeFile(join(first.cwd, 'composer.ts'), 'fixed composer\n')
    assert.equal(await readFile(join(second.cwd, 'composer.ts'), 'utf8'), 'current composer\n')
    const final = await manager.finalize(repo, first.worktreePath, first.baseCommit, 'fix: icon')
    const diff = await manager.getDiff(repo, first.baseCommit, final.headCommit)
    assert.equal(diff.commits.length, 1, 'Inherited local changes are not task commits')
    assert.match(diff.patch, /-current composer\n\+fixed composer/)
    assert.doesNotMatch(diff.patch, /openai.svg|deleted.txt/)
    const reopened = await manager.reopen(repo, 'same-prefix-one', first.branchName)
    assert.equal(await readFile(join(reopened.cwd, 'composer.ts'), 'utf8'), 'fixed composer\n')
    await manager.finalize(repo, reopened.worktreePath, first.baseCommit, 'fix: icon')
    const unchanged = await manager.finalize(repo, second.worktreePath, second.baseCommit, 'No changes')
    assert.equal(unchanged.hasChanges, false)
    assert.equal(git(repo, 'status', '--porcelain=v1'), originalStatus)
    const alias = join(directory, 'project-alias')
    await symlink(repo, alias, 'junction')
    const nested = await manager.prepare(join(alias, 'app'), 'nested-task', 'Nested project')
    assert.equal(nested.cwd, join(nested.worktreePath, 'app'))
    assert.equal(await readFile(join(nested.cwd, 'source.ts'), 'utf8'), 'nested project\n')
    await manager.finalize(repo, nested.worktreePath, nested.baseCommit, 'No changes')
    console.log('Git delivery passed: current files, isolated tasks, unchanged source index, task-only diffs, reopen, and symlinked nested projects.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
