import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { temporaryTaskBranch } from '../../shared/task-branch'
import type { GitContext, PreparedCheckout } from './types'
import { git } from './command'
import { withRepoLock, repositoryRoot, commonGitDirectory } from './repository'
import { createInitialCommit } from './commits'

export function taskWorktree(context: GitContext, taskId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    throw new Error('Invalid task ID')
  }
  const root = typeof context.worktreesRoot === 'string' ? context.worktreesRoot : context.worktreesRoot(taskId)
  return join(root, taskId)
}

/** Called only after deletion or settlement, once the agent has stopped. */
export async function releaseWorktree(context: GitContext, taskId: string): Promise<void> {
  const worktree = taskWorktree(context, taskId)
  if (!existsSync(worktree)) {
    return
  }
  try {
    await withRepoLock(context, worktree, async () => {
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

export async function verifyTaskWorktree(repoRoot: string, worktree: string, branchName: string): Promise<void> {
  const root = await repositoryRoot(worktree)
  if (root !== await realpath(worktree) || await commonGitDirectory(repoRoot) !== await commonGitDirectory(worktree)) {
    throw new Error('The task worktree does not belong to this repository. No files were changed.')
  }
  if ((await git(worktree, ['branch', '--show-current'])).stdout.trim() !== branchName) {
    throw new Error('The task worktree switched away from the task branch. No files were changed.')
  }
}

async function taskCwd(projectPath: string, repoRoot: string, worktree: string): Promise<string> {
  const cwd = join(worktree, relative(repoRoot, await realpath(projectPath)))
  await mkdir(cwd, { recursive: true })
  return cwd
}

export async function prepareBranch(
  context: GitContext,
  projectPath: string,
  taskId: string,
  check: () => void = () => {},
  base?: { commit: string; branch: string }
): Promise<PreparedCheckout> {
  const repoRoot = await repositoryRoot(projectPath)
  return withRepoLock(context, repoRoot, async () => {
    check()
    const head = await git(repoRoot, ['rev-parse', '--verify', 'HEAD'], [0, 128])
    const initializedRepository = head.exitCode !== 0
    if (initializedRepository) {
      check()
      const branchRef = (await git(repoRoot, ['symbolic-ref', 'HEAD'])).stdout.trim()
      await createInitialCommit(repoRoot, branchRef)
    }
    const baseCommit = base?.commit ?? (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim()
    const baseBranch = base?.branch ?? ((await git(repoRoot, ['branch', '--show-current'])).stdout.trim() || baseCommit)
    const branchName = temporaryTaskBranch(taskId)
    check()
    const worktree = taskWorktree(context, taskId)
    await mkdir(dirname(taskWorktree(context, taskId)), { recursive: true })
    await git(repoRoot, ['worktree', 'add', '-b', branchName, worktree, baseCommit])
    return { cwd: await taskCwd(projectPath, repoRoot, worktree), baseCommit, baseBranch, branchName, initializedRepository }
  })
}

/** Reuse the same worktree across issues, completion, restart and follow-ups. */
export async function checkoutBranch(
  context: GitContext,
  projectPath: string,
  taskId: string,
  branchName: string,
  baseBranch?: string,
  check: () => void = () => {}
): Promise<PreparedCheckout> {
  const repoRoot = await repositoryRoot(projectPath)
  return withRepoLock(context, repoRoot, async () => {
    check()
    const worktree = taskWorktree(context, taskId)
    const current = (await git(repoRoot, ['branch', '--show-current'])).stdout.trim()
    if (!existsSync(worktree)) {
      await mkdir(dirname(taskWorktree(context, taskId)), { recursive: true })
      await git(repoRoot, ['worktree', 'prune'])
      check()
      await git(repoRoot, ['worktree', 'add', worktree, branchName])
    }
    await verifyTaskWorktree(repoRoot, worktree, branchName)
    return {
      cwd: await taskCwd(projectPath, repoRoot, worktree), branchName, baseBranch: baseBranch ?? current,
      baseCommit: (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim(), initializedRepository: false
    }
  })
}

/** Manual rebase uses the task's retained worktree while rewriting its branch. */
export async function createRebaseWorktree(
  context: GitContext,
  projectPath: string,
  taskId: string,
  branchName: string,
  check: () => void
): Promise<string> {
  const worktreePath = taskWorktree(context, taskId)
  if (existsSync(worktreePath)) {
    await verifyTaskWorktree(projectPath, worktreePath, branchName)
    if ((await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()) {
      throw new Error('Commit or stash changes in the task worktree before rebasing.')
    }
    return worktreePath
  }
  await mkdir(dirname(taskWorktree(context, taskId)), { recursive: true })
  check()
  await git(projectPath, ['worktree', 'prune'], [0, 1, 128])
  check()
  await git(projectPath, ['worktree', 'add', worktreePath, branchName])
  return worktreePath
}

/** Current commit of the task worktree, or null when there is none to read.
 * Runs synchronously so turn-end recording stays ordered with the exit event. */
export function worktreeHead(context: GitContext, taskId: string): string | null {
  const worktree = taskWorktree(context, taskId)
  if (!existsSync(worktree)) {
    return null
  }
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
