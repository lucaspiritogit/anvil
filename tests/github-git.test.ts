import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitDeliveryManager } from '../src/server/git-delivery'
import { githubRepository } from '../src/shared/github-repository'

test('previews and pushes real repositories while preserving checkout, authorship and remote guards', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anvil-github-git-')))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const repo = join(directory, 'project')
  const remote = join(directory, 'remote.git')
  const remoteUrl = 'git@github.com:developer/project.git'
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commands: string[][] = []
  const manager = new GitDeliveryManager(join(directory, 'worktrees'), async (cwd, args, _accepted, env) => {
    commands.push(args)
    expect(env, 'No token or author environment overrides').toStrictEqual({ GIT_TERMINAL_PROMPT: '0' })
    expect(args.includes(remoteUrl), 'Unknown test remote').toBeTruthy()
    const mapped = args.map((arg) => arg === remoteUrl ? remote : arg)
    return { stdout: git(cwd, ...mapped), stderr: '', exitCode: 0 }
  })
  try {
    for (const url of [remoteUrl, 'https://github.com/developer/project.git', 'ssh://git@github.com/developer/project.git']) {
      expect(githubRepository(url)).toBe('developer/project')
    }
    for (const url of ['https://github.com.evil.test/developer/project', 'https://token@github.com/developer/project', 'file:///tmp/repo', 'git@other.test:developer/project', 'https://github.com/developer/project?token=secret']) {
      expect(() => githubRepository(url)).toThrow()
    }
    await mkdir(repo)
    await mkdir(remote)
    git(remote, 'init', '--bare')
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.name', 'Existing developer')
    git(repo, 'config', 'user.email', 'developer@example.invalid')
    await writeFile(join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Base')
    git(repo, 'push', remote, 'main')
    git(repo, 'remote', 'add', 'origin', remoteUrl)
    const baseCommit = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-b', 'task/pr')
    await writeFile(join(repo, 'new.txt'), 'agent change\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Agent change')
    const sourceCommit = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', 'main')
    git(repo, 'merge', '--ff-only', 'task/pr')
    await writeFile(join(repo, 'base.txt'), 'staged work\n')
    git(repo, 'add', '.')
    await writeFile(join(repo, 'base.txt'), 'unstaged work\n')
    await writeFile(join(repo, 'untracked.txt'), 'untracked work\n')
    const index = await readFile(join(repo, '.git', 'index'))
    const config = await readFile(join(repo, '.git', 'config'))
    const status = git(repo, 'status', '--porcelain')
    const preview = await manager.getPullRequestPreview(repo, 'task/pr')
    expect(preview.repository).toBe('developer/project')
    expect(preview.targetCommit).toBe(sourceCommit)
    expect(preview.remoteTargetCommit).toBe(baseCommit)
    expect(preview.commitCount, 'Count against remote base even when the task is already merged locally').toBe(1)
    expect(git(repo, 'for-each-ref', 'refs/anvil/pr-preview'), 'Temporary fetch refs are removed').toBe('')
    await manager.pushPullRequestBranch(repo, preview)
    expect(git(remote, 'rev-parse', 'refs/heads/task/pr')).toBe(sourceCommit)
    expect(git(remote, 'rev-parse', 'refs/heads/main'), 'Opening PR does not merge the remote base').toBe(baseCommit)
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    expect(await readFile(join(repo, '.git', 'index'))).toStrictEqual(index)
    expect(await readFile(join(repo, '.git', 'config'))).toStrictEqual(config)
    expect(git(repo, 'status', '--porcelain')).toBe(status)
    expect(await readFile(join(repo, 'base.txt'), 'utf8')).toBe('unstaged work\n')
    expect(git(remote, 'show', '-s', '--format=%an <%ae>', sourceCommit)).toBe('Existing developer <developer@example.invalid>')
    expect(commands.at(-1)).toStrictEqual(['push', '--porcelain', '--', remoteUrl, `${sourceCommit}:refs/heads/task/pr`])
    git(repo, 'push', remote, `${sourceCommit}:refs/heads/main`)
    await expect(manager.pushPullRequestBranch(repo, preview)).rejects.toThrow(/branches or remote changed/)
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/other/project.git')
    await expect(manager.pushPullRequestBranch(repo, preview)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
