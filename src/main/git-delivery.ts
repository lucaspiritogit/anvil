import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { githubRepository } from './github-repository'
import type {
  ProjectGitStatus,
  ProjectBranches,
  PullRequestGitPreview,
  RebaseStep,
  TaskCommit,
  TaskDiff,
  TaskMergePreview
} from '../shared/types'

const execFileAsync = promisify(execFile)

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface PreparedCheckout {
  baseBranch: string
  branchName: string
  baseCommit: string
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
  check?: () => void
}

export interface FinalizedCheckout {
  headCommit: string
  branchName?: string
  hasChanges: boolean
  finisherCommitted: boolean
  filesChanged: number
  additions: number
  deletions: number
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

function parseNumstat(output: string): Pick<FinalizedCheckout, 'filesChanged' | 'additions' | 'deletions'> {
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

  constructor(private readonly worktreesRoot: string | ((taskId: string) => string), private readonly remoteGit: typeof git = git) {}

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

  async branches(projectPath: string): Promise<ProjectBranches> {
    const [current, branches] = await Promise.all([
      git(projectPath, ['branch', '--show-current']),
      git(projectPath, ['for-each-ref', '--sort=refname', '--format=%(refname:strip=2)%09%(worktreepath)', 'refs/heads/'])
    ])
    return {
      currentBranch: current.stdout.trim() || null,
      branches: branches.stdout.split('\n').filter(Boolean).map((line) => {
        const [name, worktreePath] = line.split('\t')
        return { name, checkedOut: Boolean(worktreePath) }
      })
    }
  }

  async switchProjectBranch(projectPath: string, branchName: string): Promise<ProjectBranches> {
    return this.withRepoLock(projectPath, async () => {
      await git(projectPath, ['check-ref-format', `refs/heads/${branchName}`])
      await git(projectPath, ['show-ref', '--verify', `refs/heads/${branchName}`])
      // Never guess a remote branch or force away local changes.
      await git(projectPath, ['switch', '--no-guess', '--', branchName])
      return this.branches(projectPath)
    })
  }

  private taskWorktree(taskId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('Invalid task ID')
    const root = typeof this.worktreesRoot === 'string' ? this.worktreesRoot : this.worktreesRoot(taskId)
    return join(root, taskId)
  }

  /** Called only after deletion or settlement, once the agent has stopped. */
  async releaseWorktree(taskId: string): Promise<void> {
    const worktree = this.taskWorktree(taskId)
    if (!existsSync(worktree)) return
    try {
      await this.withRepoLock(worktree, async () => {
        if (existsSync(worktree)) {
          // Windows cannot remove the working directory of the Git process itself.
          const commonDir = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
          await git(commonDir, ['worktree', 'remove', '--force', worktree])
        }
      })
    } catch (error) {
      console.warn(`Could not clean up task worktree ${taskId}:`, error)
    }
  }

  private async verifyTaskWorktree(repoRoot: string, worktree: string, branchName: string): Promise<void> {
    const root = await realpath((await git(worktree, ['rev-parse', '--show-toplevel'])).stdout.trim())
    const common = async (path: string): Promise<string> => realpath((await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim())
    if (root !== await realpath(worktree) || await common(repoRoot) !== await common(worktree)) {
      throw new Error('The task worktree does not belong to this repository. No files were changed.')
    }
    if ((await git(worktree, ['branch', '--show-current'])).stdout.trim() !== branchName) {
      throw new Error('The task worktree switched away from the task branch. No files were changed.')
    }
  }

  private async taskCwd(projectPath: string, repoRoot: string, worktree: string): Promise<string> {
    const cwd = join(worktree, relative(repoRoot, await realpath(projectPath)))
    await mkdir(cwd, { recursive: true })
    return cwd
  }

  async prepareBranch(projectPath: string, taskId: string, title: string, check: () => void = () => {}): Promise<PreparedCheckout> {
    const repoRoot = await realpath((await git(projectPath, ['rev-parse', '--show-toplevel'])).stdout.trim())
    return this.withRepoLock(repoRoot, async () => {
      check()
      const head = await git(repoRoot, ['rev-parse', '--verify', 'HEAD'], [0, 128])
      const initializedRepository = head.exitCode !== 0
      if (initializedRepository) {
        check()
        const branchRef = (await git(repoRoot, ['symbolic-ref', 'HEAD'])).stdout.trim()
        await this.createInitialCommit(repoRoot, branchRef)
      }
      const baseCommit = (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim()
      const baseBranch = (await git(repoRoot, ['branch', '--show-current'])).stdout.trim() || baseCommit
      const branchName = `${slug(title)}-${taskId}`
      check()
      const worktree = this.taskWorktree(taskId)
      await mkdir(dirname(this.taskWorktree(taskId)), { recursive: true })
      await git(repoRoot, ['worktree', 'add', '-b', branchName, worktree, baseCommit])
      return { cwd: await this.taskCwd(projectPath, repoRoot, worktree), baseCommit, baseBranch, branchName, initializedRepository }
    })
  }

  /** Reuse the same worktree across issues, completion, restart and follow-ups. */
  async checkoutBranch(projectPath: string, taskId: string, branchName: string, baseBranch?: string, check: () => void = () => {}): Promise<PreparedCheckout> {
    const repoRoot = await realpath((await git(projectPath, ['rev-parse', '--show-toplevel'])).stdout.trim())
    return this.withRepoLock(repoRoot, async () => {
      check()
      const worktree = this.taskWorktree(taskId)
      const current = (await git(repoRoot, ['branch', '--show-current'])).stdout.trim()
      if (!existsSync(worktree)) {
        // Tasks saved by the old in-place runner may still occupy the project checkout.
        if (current === branchName) {
          if (!baseBranch || baseBranch === branchName || (await git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()) {
            throw new Error('This older task still uses the project checkout. Commit or stash its changes and check out another project branch before resuming.')
          }
          check()
          await git(repoRoot, ['checkout', baseBranch])
        }
        await mkdir(dirname(this.taskWorktree(taskId)), { recursive: true })
        await git(repoRoot, ['worktree', 'prune'])
        check()
        await git(repoRoot, ['worktree', 'add', worktree, branchName])
      }
      await this.verifyTaskWorktree(repoRoot, worktree, branchName)
      return {
        cwd: await this.taskCwd(projectPath, repoRoot, worktree), branchName, baseBranch: baseBranch ?? current,
        baseCommit: (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim(), initializedRepository: false
      }
    })
  }

  async finalizeBranch(projectPath: string, taskId: string, branchName: string, _baseBranch: string | undefined, baseCommit: string, title: string, options: FinalizeOptions = {}): Promise<FinalizedCheckout> {
    const repoRoot = await realpath((await git(projectPath, ['rev-parse', '--show-toplevel'])).stdout.trim())
    return this.withRepoLock(repoRoot, async () => {
      options.check?.()
      const worktree = this.taskWorktree(taskId)
      await this.verifyTaskWorktree(repoRoot, worktree, branchName)
      options.check?.()
      return this.commitCheckout(worktree, baseCommit, title, options)
    })
  }

  /** Establish a common ancestor without committing files or changing the user's index. */
  private async createInitialCommit(repoRoot: string, branchRef: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'anvil-initial-'))
    const env = { GIT_INDEX_FILE: join(directory, 'index') }
    try {
      await git(repoRoot, ['read-tree', '--empty'], [0], env)
      const tree = (await git(repoRoot, ['write-tree'], [0], env)).stdout.trim()
      const commit = (await git(repoRoot, ['commit-tree', tree, '-m', 'Initial commit'], [0], env)).stdout.trim()
      // Fail if another process initialized this branch in the meantime.
      await git(repoRoot, ['update-ref', branchRef, commit, ''])
      return commit
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async withRepoLock<T>(repoRoot: string, action: () => Promise<T>): Promise<T> {
    // Linked worktrees, subdirectories and symlink aliases share the common Git directory.
    const common = (await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
    repoRoot = await realpath(common)
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

  /** Manual rebase uses the task's retained worktree while rewriting its branch. */
  private async createRebaseWorktree(projectPath: string, taskId: string, branchName: string, check: () => void): Promise<string> {
    const worktreePath = this.taskWorktree(taskId)
    if (existsSync(worktreePath)) {
      await this.verifyTaskWorktree(projectPath, worktreePath, branchName)
      if ((await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()) {
        throw new Error('Commit or stash changes in the task worktree before rebasing.')
      }
      return worktreePath
    }
    await mkdir(dirname(this.taskWorktree(taskId)), { recursive: true })
    check()
    await git(projectPath, ['worktree', 'prune'], [0, 1, 128])
    check()
    await git(projectPath, ['worktree', 'add', worktreePath, branchName])
    return worktreePath
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
    steps: RebaseStep[],
    check: () => void = () => {}
  ): Promise<RebasedBranch> {
    const groups = planGroups(steps)
    if (!groups.length) throw new Error('A rebase has to keep at least one commit')

    return this.withRepoLock(projectPath, async () => {
      check()
      const worktree = await this.createRebaseWorktree(projectPath, taskId, branchName, check)
      const originalTip = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim()

      // The plan was built from a commit list that may since have moved.
      const actual = (await git(worktree, ['rev-list', '--reverse', `${baseCommit}..HEAD`])).stdout
        .split(/\r?\n/)
        .filter(Boolean)
      const planned = steps.map((step) => step.sha)
      if (actual.length !== planned.length || actual.some((sha, i) => sha !== planned[i])) {
        throw new Error('This branch changed since the commit list was loaded. Reopen it and retry.')
      }

      try {
        check()
        await git(worktree, ['reset', '--hard', baseCommit])
        for (const group of groups) {
          for (const sha of group.shas) {
            check()
            await git(worktree, ['cherry-pick', '--no-commit', sha])
          }
          // A group whose changes cancel out leaves nothing staged; git drops such
          // a commit during a real rebase, so this does too.
          const staged = await git(worktree, ['diff', '--cached', '--quiet'], [0, 1])
          if (staged.exitCode === 0) continue
          check()
          await git(worktree, ['commit', '-m', group.message])
        }
      } catch (error) {
        await git(worktree, ['cherry-pick', '--abort'], [0, 1, 128])
        await git(worktree, ['reset', '--hard', originalTip], [0, 1, 128])
        throw new Error(
          `Rebase failed and the branch was left untouched: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }

      const headCommit = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim()
      const numstat = await git(worktree, ['diff', '--numstat', baseCommit, headCommit, '--'])
      const stats = parseNumstat(numstat.stdout)

      const { commits } = await this.getDiff(projectPath, baseCommit, headCommit)
      return { headCommit, commits, ...stats }
    })
  }

  private async commitCheckout(
    checkoutPath: string,
    baseCommit: string,
    fallbackMessage: string,
    options: FinalizeOptions = {}
  ): Promise<FinalizedCheckout> {
    const { onFinisherCommand } = options
    const dirty = (await git(checkoutPath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout
    const finisherCommitted = dirty.trim().length > 0
    if (dirty.trim()) {
      // The agent was asked to commit its own work and did not, so Anvil commits
      // the remainder rather than losing it. Each command is reported as it runs.
      for (const args of [['add', '--all'], ['commit', '-m', fallbackMessage]]) {
        options.check?.()
        onFinisherCommand?.(formatGitCommand(args))
        options.check?.()
        await git(checkoutPath, args)
      }
    }

    options.check?.()
    if ((await git(checkoutPath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()) {
      throw new Error('The task worktree still has uncommitted changes after finalization.')
    }
    const headCommit = (await git(checkoutPath, ['rev-parse', 'HEAD'])).stdout.trim()
    // Include the task branch with the final diff.
    const branchName = (await git(checkoutPath, ['branch', '--show-current'])).stdout.trim()
    const numstat = await git(checkoutPath, ['diff', '--numstat', baseCommit, headCommit, '--'])
    const stats = parseNumstat(numstat.stdout)
    const changes = await git(checkoutPath, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', baseCommit, headCommit, '--'], [0, 1])
    options.check?.()
    return {
      headCommit,
      ...(branchName ? { branchName } : {}),
      hasChanges: changes.exitCode === 1,
      finisherCommitted,
      ...stats
    }
  }

  async getPullRequestPreview(projectPath: string, branchName: string): Promise<PullRequestGitPreview> {
    const remoteUrl = await this.pullRequestRemote(projectPath)
    const repository = githubRepository(remoteUrl)
    const local = await this.getMergePreview(projectPath, branchName)
    const temporaryRef = `refs/anvil/pr-preview/${randomUUID()}`
    try {
      // Fetch into a private ref, not the user's checkout, index, or FETCH_HEAD.
      await this.remoteGit(projectPath, ['fetch', '--no-tags', '--no-write-fetch-head', '--', remoteUrl, `refs/heads/${local.targetBranch}:${temporaryRef}`], [0], { GIT_TERMINAL_PROMPT: '0' })
      const remoteTargetCommit = (await git(projectPath, ['rev-parse', '--verify', temporaryRef])).stdout.trim()
      const commitCount = Number((await git(projectPath, ['rev-list', '--count', `${remoteTargetCommit}..${local.sourceCommit}`])).stdout.trim())
      return { ...local, repository, remote: 'origin', remoteTargetCommit, commitCount }
    } finally {
      await git(projectPath, ['update-ref', '-d', temporaryRef])
    }
  }

  private async pullRequestRemote(projectPath: string): Promise<string> {
    const remotes = (await git(projectPath, ['remote', 'get-url', '--push', '--all', 'origin'])).stdout.trim().split(/\r?\n/)
    if (remotes.length !== 1 || !remotes[0]) throw new Error('Configure exactly one origin push URL before opening a PR.')
    githubRepository(remotes[0])
    return remotes[0]
  }

  async pushPullRequestBranch(projectPath: string, expected: PullRequestGitPreview, check: () => void = () => {}): Promise<void> {
    const repoRoot = await realpath((await git(projectPath, ['rev-parse', '--show-toplevel'])).stdout.trim())
    await this.withRepoLock(repoRoot, async () => {
      const current = await this.getPullRequestPreview(repoRoot, expected.sourceBranch)
      if (current.repository !== expected.repository || current.sourceCommit !== expected.sourceCommit ||
        current.targetBranch !== expected.targetBranch || current.targetCommit !== expected.targetCommit ||
        current.remoteTargetCommit !== expected.remoteTargetCommit || current.commitCount !== expected.commitCount) {
        throw new Error('The branches or remote changed. Close this dialog and open PR again to refresh the preview.')
      }
      const remoteUrl = await this.pullRequestRemote(repoRoot)
      if (githubRepository(remoteUrl) !== expected.repository) throw new Error('The origin remote changed. Reopen the PR dialog.')
      // Explicit refspec, no force, no credential overrides, no author changes.
      check()
      await this.remoteGit(repoRoot, ['push', '--porcelain', '--', remoteUrl, `${expected.sourceCommit}:refs/heads/${expected.sourceBranch}`], [0], { GIT_TERMINAL_PROMPT: '0' })
    })
  }

  async getMergePreview(projectPath: string, branchName: string): Promise<TaskMergePreview> {
    await git(projectPath, ['check-ref-format', `refs/heads/${branchName}`])
    const targetBranch = (await git(projectPath, ['branch', '--show-current'])).stdout.trim()
    if (!targetBranch) throw new Error('Check out a branch in the project before approving this task.')
    if (targetBranch === branchName) throw new Error('The task branch is checked out in the project. Check out the destination branch first.')

    const sourceCommit = (await git(projectPath, ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`])).stdout.trim()
    const targetCommit = (await git(projectPath, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    const commitCount = Number((await git(projectPath, ['rev-list', '--count', `${targetCommit}..${sourceCommit}`])).stdout.trim())
    return { sourceBranch: branchName, targetBranch, sourceCommit, targetCommit, commitCount }
  }

  /** Merge only the branch tips the user confirmed, without switching their checkout. */
  async merge(projectPath: string, branchName: string, expected: TaskMergePreview, check: () => void = () => {}): Promise<void> {
    const repoRoot = await realpath((await git(projectPath, ['rev-parse', '--show-toplevel'])).stdout.trim())
    await this.withRepoLock(repoRoot, async () => {
      const current = await this.getMergePreview(repoRoot, branchName)
      if (!expected || current.sourceBranch !== expected.sourceBranch || current.targetBranch !== expected.targetBranch ||
        current.sourceCommit !== expected.sourceCommit || current.targetCommit !== expected.targetCommit ||
        current.commitCount !== expected.commitCount) {
        throw new Error('The branches changed since the merge preview was loaded. Close this dialog and approve again.')
      }

      for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        const operationPath = (await git(repoRoot, ['rev-parse', '--git-path', operation])).stdout.trim()
        if (existsSync(isAbsolute(operationPath) ? operationPath : join(repoRoot, operationPath))) {
          throw new Error('Finish or abort the existing Git operation before approving this task.')
        }
      }
      const dirty = (await git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()
      if (dirty) throw new Error('Commit or stash local changes in the project before approving this task.')

      check()
      try {
        await git(repoRoot, ['-c', 'merge.autoStash=false', 'merge', '--no-edit', '--commit', '--no-squash', '--no-autostash', `refs/heads/${branchName}`])
      } catch (error) {
        const mergeHead = await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [0, 1])
        if (mergeHead.exitCode === 0) {
          try {
            await git(repoRoot, ['merge', '--abort'])
          } catch (abortError) {
            throw new Error(`Merge failed: ${error instanceof Error ? error.message : String(error)}. Could not abort the merge: ${abortError instanceof Error ? abortError.message : String(abortError)}`)
          }
        }
        throw new Error(`Merge failed. The task was not approved: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  async getDiff(repoPath: string, baseCommit: string, headCommit: string): Promise<TaskDiff> {
    const [patch, log] = await Promise.all([
      git(repoPath, ['diff', '--find-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', baseCommit, headCommit, '--']),
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

  /** Current commit of the task worktree, or null when there is none to read.
   * Runs synchronously so turn-end recording stays ordered with the exit event. */
  worktreeHead(taskId: string): string | null {
    const worktree = this.taskWorktree(taskId)
    if (!existsSync(worktree)) return null
    try {
      const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      return head.trim() || null
    } catch {
      return null
    }
  }

  /** Review diff for one issue; issues without a recorded range fall back to the whole task diff. */
  async getIssueDiff(repoPath: string, source: IssueDiffSource): Promise<TaskDiff | null> {
    if (source.baseCommit && source.headCommit) return this.getDiff(repoPath, source.baseCommit, source.headCommit)
    if (!source.baseCommit && !source.headCommit && source.taskBaseCommit && source.taskHeadCommit) {
      return this.getDiff(repoPath, source.taskBaseCommit, source.taskHeadCommit)
    }
    return null
  }
}

export interface IssueDiffSource {
  /** Commits recorded for the issue itself, captured at claim and turn finalization. */
  baseCommit?: string | null
  headCommit?: string | null
  /** Whole-task range; the fallback for legacy issues without a recorded range. */
  taskBaseCommit?: string | null
  taskHeadCommit?: string | null
}
