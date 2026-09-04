import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { RunCommit, RunDiff } from '../shared/types'

const execFileAsync = promisify(execFile)

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface PreparedWorktree {
  baseBranch: string
  branchName: string
  baseCommit: string
  worktreePath: string
  cwd: string
  initializedRepository: boolean
}

export interface FinalizedWorktree {
  headCommit: string
  hasChanges: boolean
  finisherCommitted: boolean
  filesChanged: number
  additions: number
  deletions: number
  cleanupWarning?: string
}

async function git(cwd: string, args: string[], acceptedCodes: number[] = [0]): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string }
    if (typeof failure.code === 'number' && acceptedCodes.includes(failure.code)) {
      return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code }
    }
    const detail = (failure.stderr || failure.stdout || failure.message).trim()
    throw new Error(detail || `git ${args[0]} failed`)
  }
}

function slug(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36)
  return clean || 'task'
}

function parseNumstat(output: string): Pick<FinalizedWorktree, 'filesChanged' | 'additions' | 'deletions'> {
  let filesChanged = 0
  let additions = 0
  let deletions = 0
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    const [added, deleted] = line.split('\t')
    filesChanged += 1
    if (added !== '-') additions += Number(added) || 0
    if (deleted !== '-') deletions += Number(deleted) || 0
  }
  return { filesChanged, additions, deletions }
}

export class GitDeliveryManager {
  private readonly repoLocks = new Map<string, Promise<void>>()

  constructor(private readonly worktreesRoot: string) {}

  async prepare(projectPath: string, runId: string, title: string): Promise<PreparedWorktree> {
    const repoRoot = (await git(projectPath, ['rev-parse', '--show-toplevel'])).stdout.trim()
    return this.withRepoLock(repoRoot, async () => {
      const head = await git(repoRoot, ['rev-parse', '--verify', 'HEAD'], [0, 128])
      let baseCommit = head.stdout.trim()
      let initializedRepository = false

      if (head.exitCode !== 0) {
        const headBranch = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])
        if (headBranch.exitCode !== 0 || !headBranch.stdout.trim()) {
          const detail = (head.stderr || headBranch.stderr).trim()
          throw new Error(detail || 'Git HEAD could not be resolved')
        }

        await git(repoRoot, ['add', '--all'])
        await git(repoRoot, [
          'commit',
          '--allow-empty',
          '-m',
          'Initial commit'
        ])
        baseCommit = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
        initializedRepository = true
      }

      const branchResult = await git(repoRoot, ['branch', '--show-current'])
      const baseBranch = branchResult.stdout.trim() || baseCommit.slice(0, 12)
      const branchName = `anvil/${slug(title)}-${runId.slice(0, 8)}`
      const projectRelativePath = relative(resolve(repoRoot), resolve(projectPath))
      if (projectRelativePath.startsWith('..')) {
        throw new Error('Project path is outside its Git repository')
      }

      await mkdir(this.worktreesRoot, { recursive: true })
      const worktreePath = join(this.worktreesRoot, runId)
      await git(repoRoot, ['worktree', 'add', '-b', branchName, worktreePath, baseCommit])

      return {
        baseBranch,
        branchName,
        baseCommit,
        worktreePath,
        cwd: projectRelativePath ? join(worktreePath, projectRelativePath) : worktreePath,
        initializedRepository
      }
    })
  }

  private async withRepoLock<T>(repoRoot: string, action: () => Promise<T>): Promise<T> {
    const previous = this.repoLocks.get(repoRoot) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock
    })
    const queued = previous.then(() => current)
    this.repoLocks.set(repoRoot, queued)
    await previous

    try {
      return await action()
    } finally {
      release()
      if (this.repoLocks.get(repoRoot) === queued) this.repoLocks.delete(repoRoot)
    }
  }

  async finalize(
    repoPath: string,
    worktreePath: string,
    baseCommit: string,
    title: string,
    onUncommittedChanges?: () => void
  ): Promise<FinalizedWorktree> {
    const dirty = (await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout
    const finisherCommitted = dirty.trim().length > 0
    if (dirty.trim()) {
      onUncommittedChanges?.()
      await git(worktreePath, ['add', '--all'])
      await git(worktreePath, [
        '-c',
        'user.name=Anvil',
        '-c',
        'user.email=anvil@localhost',
        'commit',
        '-m',
        `anvil: ${title}`
      ])
    }

    const headCommit = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    const numstat = await git(worktreePath, ['diff', '--numstat', baseCommit, headCommit, '--'])
    const stats = parseNumstat(numstat.stdout)
    let cleanupWarning: string | undefined
    try {
      await git(repoPath, ['worktree', 'remove', '--force', worktreePath])
    } catch (error) {
      cleanupWarning = error instanceof Error ? error.message : String(error)
    }
    return {
      headCommit,
      hasChanges: stats.filesChanged > 0,
      finisherCommitted,
      ...stats,
      cleanupWarning
    }
  }

  async getDiff(repoPath: string, baseCommit: string, headCommit: string): Promise<RunDiff> {
    const [patch, log] = await Promise.all([
      git(repoPath, ['diff', '--find-renames', '--no-color', baseCommit, headCommit, '--']),
      git(repoPath, ['log', '--format=%H%x09%s', `${baseCommit}..${headCommit}`])
    ])
    const commits: RunCommit[] = log.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const split = line.indexOf('\t')
        return { sha: line.slice(0, split), subject: line.slice(split + 1) }
      })
    return { patch: patch.stdout, commits }
  }
}
