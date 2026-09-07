import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitDeliveryManager } from '../src/main/git-delivery'
import { githubRepository } from '../src/main/github-repository'

async function main(): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anvil-github-git-')))
  const repo = join(directory, 'project')
  const remote = join(directory, 'remote.git')
  const remoteUrl = 'git@github.com:developer/project.git'
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commands: string[][] = []
  const manager = new GitDeliveryManager(join(directory, 'worktrees'), async (cwd, args, _accepted, env) => {
    commands.push(args)
    assert.deepEqual(env, { GIT_TERMINAL_PROMPT: '0' }, 'No token or author environment overrides')
    assert.ok(args.includes(remoteUrl), 'Unknown test remote')
    const mapped = args.map((arg) => arg === remoteUrl ? remote : arg)
    return { stdout: git(cwd, ...mapped), stderr: '', exitCode: 0 }
  })
  try {
    for (const url of [remoteUrl, 'https://github.com/developer/project.git', 'ssh://git@github.com/developer/project.git']) {
      assert.equal(githubRepository(url), 'developer/project')
    }
    for (const url of ['https://github.com.evil.test/developer/project', 'https://token@github.com/developer/project', 'file:///tmp/repo', 'git@other.test:developer/project', 'https://github.com/developer/project?token=secret']) {
      assert.throws(() => githubRepository(url))
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
    assert.equal(preview.repository, 'developer/project')
    assert.equal(preview.targetCommit, sourceCommit)
    assert.equal(preview.remoteTargetCommit, baseCommit)
    assert.equal(preview.commitCount, 1, 'Count against remote base even when the task is already merged locally')
    assert.equal(git(repo, 'for-each-ref', 'refs/anvil/pr-preview'), '', 'Temporary fetch refs are removed')
    await manager.pushPullRequestBranch(repo, preview)
    assert.equal(git(remote, 'rev-parse', 'refs/heads/task/pr'), sourceCommit)
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), baseCommit, 'Opening PR does not merge the remote base')
    assert.equal(git(repo, 'branch', '--show-current'), 'main')
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), index)
    assert.deepEqual(await readFile(join(repo, '.git', 'config')), config)
    assert.equal(git(repo, 'status', '--porcelain'), status)
    assert.equal(await readFile(join(repo, 'base.txt'), 'utf8'), 'unstaged work\n')
    assert.equal(git(remote, 'show', '-s', '--format=%an <%ae>', sourceCommit), 'Existing developer <developer@example.invalid>')
    assert.deepEqual(commands.at(-1), ['push', '--porcelain', '--', remoteUrl, `${sourceCommit}:refs/heads/task/pr`])
    git(repo, 'push', remote, `${sourceCommit}:refs/heads/main`)
    await assert.rejects(manager.pushPullRequestBranch(repo, preview), /branches or remote changed/)
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/other/project.git')
    await assert.rejects(manager.pushPullRequestBranch(repo, preview))
    console.log('GitHub Git passed: remote base counts, ordinary non-force push, stale previews, preserved checkout/index/config/authorship, and remote validation.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
