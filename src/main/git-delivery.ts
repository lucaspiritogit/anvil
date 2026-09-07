import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  ProjectGitStatus,
  RebaseStep,
  TaskCommit,
  TaskDiff
} from '../shared/types'

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

export interface RebasedBranch {
  headCommit: string
  commits: TaskCommit[]
  filesChanged: number
  additions: number
  deletions: number
}

export interface FinalizeOptions {
  onFinisherCommand?: (command: string) => void
}

export interface FinalizedWorktree {
  headCommit: string
  branchName?: string
  hasChanges: boolean
  finisherCommitted: boolean
  filesChanged: number
  additions: number
  deletions: number
  cleanupWarning?: string
}

async function git(cwd: string, args: string[], acceptedCodes: number[] = [0], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
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

function formatGitCommand(args: string[]): string {
  const rendered = args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')
  return `$ git ${rendered}`
}

function slug(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36)
  return clean || 'task'
}

interface RebaseGroup {
  message: string
  shas: string[]
}

/**
 * Folds a step list into the commits it produces. A `squash` before any `pick`
 * has nothing to fold into, so it is treated as starting its own commit — the
 * same forgiving reading `git rebase` applies when a todo list starts with one.
 */
function planGroups(steps: RebaseStep[]): RebaseGroup[] {
  const groups: RebaseGroup[] = []
  for (const step of steps) {
    if (step.action === 'drop') continue
    const current = groups[groups.length - 1]
    if (step.action === 'squash' && current) {
      current.shas.push(step.sha)
      continue
    }
    groups.push({ message: step.message.trim() || 'Rebased commit', shas: [step.sha] })
  }
  return groups
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

  /**
   * Resolves whether a project folder is inside a Git work tree. Never throws:
   * a folder without Git, or a machine without the `git` binary, has to keep
   * working with the Git flow skipped rather than failing the task.
   */
  async status(projectPath: string): Promise<ProjectGitStatus> {
    const pathExists = existsSync(projectPath)
    if (!pathExists) {
      return { isRepository: false, repoRoot: null, gitAvailable: true, pathExists }
    }

    try {
      const result = await git(projectPath, ['rev-parse', '--show-toplevel'], [0, 128, 129])
      const repoRoot = result.stdout.trim()
      if (result.exitCode !== 0 || !repoRoot) {
        return { isRepository: false, repoRoot: null, gitAvailable: true, pathExists }
      }
      return { isRepository: true, repoRoot, gitAvailable: true, pathExists }
    } catch {
      // The folder is there, so the failure is the `git` binary itself.
      return { isRepository: false, repoRoot: null, gitAvailable: false, pathExists }
    }
  }

  /** Runs `git init` in the project folder and reports the resulting status. */
  async init(projectPath: string): Promise<ProjectGitStatus> {
    await git(projectPath, ['init'])
    return this.status(projectPath)
  }

  async prepare(projectPath: string, taskId: string, title: string): Promise<PreparedWorktree> {
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
      const branchName = `${slug(title)}-${taskId}`
      const projectRelativePath = relative(await realpath(repoRoot), await realpath(projectPath))
      if (projectRelativePath === '..' || projectRelativePath.startsWith(`..${sep}`) || isAbsolute(projectRelativePath)) {
        throw new Error('Project path is outside its Git repository')
      }

      await mkdir(this.worktreesRoot, { recursive: true })
      const worktreePath = join(this.worktreesRoot, taskId)
      baseCommit = await this.snapshot(repoRoot, baseCommit, taskId)
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

  /** Capture local code without staging, stashing, or committing on the user's branch. */
  private async snapshot(repoRoot: string, parent: string, taskId: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'anvil-snapshot-'))
    const env = { GIT_INDEX_FILE: join(directory, 'index') }
    try {
      await git(repoRoot, ['read-tree', parent], [0], env)
      // Runtime databases and secrets are not task inputs. Git's ignore rules
      // also keep dependency directories and other ignored files out.
      const paths = ['.', ':(exclude,glob)**/.valence/**', ':(exclude,glob)**/.anvil-composer/**', ':(exclude,glob)**/.env', ':(exclude,glob)**/.env.*']
      const managedRelativePath = relative(await realpath(repoRoot), await realpath(this.worktreesRoot))
      if (managedRelativePath && managedRelativePath !== '..' && !managedRelativePath.startsWith(`..${sep}`) && !isAbsolute(managedRelativePath)) {
        paths.push(`:(exclude,literal)${managedRelativePath}`)
      }
      await git(repoRoot, ['add', '--all', '--', ...paths], [0], env)
      const tree = (await git(repoRoot, ['write-tree'], [0], env)).stdout.trim()
      const parentTree = (await git(repoRoot, ['rev-parse', `${parent}^{tree}`])).stdout.trim()
      if (tree === parentTree) return parent
      return (await git(repoRoot, ['commit-tree', tree, '-p', parent, '-m', `Anvil task ${taskId} starting snapshot`], [0], env)).stdout.trim()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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

  /**
   * Re-opens a worktree on a branch a finished task left behind, so the agent
   * can act on review notes. `finalize` removes the worktree when a task ends,
   * but the branch survives — this checks it out again at the same path.
   */
  async reopen(projectPath: string, taskId: string, branchName: string): Promise<PreparedWorktree> {
    const repoRoot = (await git(projectPath, ['rev-parse', '--show-toplevel'])).stdout.trim()
    return this.withRepoLock(repoRoot, async () => {
      const worktreePath = join(this.worktreesRoot, taskId)
      await mkdir(this.worktreesRoot, { recursive: true })
      // A worktree left behind by a failed cleanup would block `worktree add`.
      await git(repoRoot, ['worktree', 'prune'], [0, 1, 128])
      await git(repoRoot, ['worktree', 'add', worktreePath, branchName])

      const baseCommit = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
      const projectRelativePath = relative(await realpath(repoRoot), await realpath(projectPath))
      return {
        baseBranch: branchName,
        branchName,
        baseCommit,
        worktreePath,
        cwd: projectRelativePath ? join(worktreePath, projectRelativePath) : worktreePath,
        initializedRepository: false
      }
    })
  }

  /**
   * Replays a task's commits according to a plan, the way `git rebase -i` does:
   * a `pick` starts a commit, a following `squash` folds into it, and a `drop`
   * is left out. Anvil runs this itself rather than asking git for an
   * interactive session, so there is no editor to drive and the outcome is
   * exactly what the plan said.
   *
   * The branch is reset to its base and the kept commits are re-applied with
   * `cherry-pick --no-commit`. Nothing is lost if that fails part-way: the
   * original tip is recorded first and restored before the error is raised.
   */
  async rebase(
    projectPath: string,
    taskId: string,
    branchName: string,
    baseCommit: string,
    steps: RebaseStep[]
  ): Promise<RebasedBranch> {
    const groups = planGroups(steps)
    if (!groups.length) throw new Error('A rebase has to keep at least one commit')

    const prepared = await this.reopen(projectPath, taskId, branchName)
    const worktree = prepared.worktreePath
    const originalTip = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim()

    // The plan was built from a commit list that may since have moved.
    const actual = (await git(worktree, ['rev-list', '--reverse', `${baseCommit}..HEAD`])).stdout
      .split(/\r?\n/)
      .filter(Boolean)
    const planned = steps.map((step) => step.sha)
    if (actual.length !== planned.length || actual.some((sha, i) => sha !== planned[i])) {
      await git(projectPath, ['worktree', 'remove', '--force', worktree], [0, 1, 128])
      throw new Error('This branch changed since the commit list was loaded. Reopen it and retry.')
    }

    try {
      await git(worktree, ['reset', '--hard', baseCommit])
      for (const group of groups) {
        for (const sha of group.shas) {
          await git(worktree, ['cherry-pick', '--no-commit', sha])
        }
        // A group whose changes cancel out leaves nothing staged; git drops such
        // a commit during a real rebase, so this does too.
        const staged = await git(worktree, ['diff', '--cached', '--quiet'], [0, 1])
        if (staged.exitCode === 0) continue
        await git(worktree, ['commit', '-m', group.message])
      }
    } catch (error) {
      await git(worktree, ['cherry-pick', '--abort'], [0, 1, 128])
      await git(worktree, ['reset', '--hard', originalTip], [0, 1, 128])
      await git(projectPath, ['worktree', 'remove', '--force', worktree], [0, 1, 128])
      throw new Error(
        `Rebase failed and the branch was left untouched: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    const headCommit = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim()
    const numstat = await git(worktree, ['diff', '--numstat', baseCommit, headCommit, '--'])
    const stats = parseNumstat(numstat.stdout)
    await git(projectPath, ['worktree', 'remove', '--force', worktree], [0, 1, 128])

    const { commits } = await this.getDiff(projectPath, baseCommit, headCommit)
    return { headCommit, commits, ...stats }
  }

  async finalize(
    repoPath: string,
    worktreePath: string,
    baseCommit: string,
    fallbackMessage: string,
    options: FinalizeOptions = {}
  ): Promise<FinalizedWorktree> {
    const { onFinisherCommand } = options
    const dirty = (await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout
    const finisherCommitted = dirty.trim().length > 0
    if (dirty.trim()) {
      // The agent was asked to commit its own work and did not, so Anvil commits
      // the remainder rather than losing it. Each command is reported as it runs.
      for (const args of [['add', '--all'], ['commit', '-m', fallbackMessage]]) {
        onFinisherCommand?.(formatGitCommand(args))
        await git(worktreePath, args)
      }
    }

    const headCommit = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    // Read before the worktree goes away: the agent may have renamed the branch.
    const branchName = (await git(worktreePath, ['branch', '--show-current'])).stdout.trim()
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
      ...(branchName ? { branchName } : {}),
      hasChanges: stats.filesChanged > 0,
      finisherCommitted,
      ...stats,
      cleanupWarning
    }
  }

  async getDiff(repoPath: string, baseCommit: string, headCommit: string): Promise<TaskDiff> {
    const [patch, log] = await Promise.all([
      git(repoPath, ['diff', '--find-renames', '--no-color', baseCommit, headCommit, '--']),
      git(repoPath, ['log', '--format=%H%x09%s', `${baseCommit}..${headCommit}`])
    ])
    const commits: TaskCommit[] = log.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const split = line.indexOf('\t')
        return { sha: line.slice(0, split), subject: line.slice(split + 1) }
      })
    return { patch: patch.stdout, commits }
  }
}
