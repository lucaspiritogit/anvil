import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GitContext, FinalizeOptions, FinalizedCheckout } from './types'
import { git } from './command'
import { withRepoLock, repositoryRoot, commonGitDirectory } from './repository'
import { taskWorktree, verifyTaskWorktree } from './worktrees'
import { commitCheckout, parseNumstat } from './commits'

/** Rename only an existing task checkout, accepting retries of an applied rename. */
export async function renameTaskBranch(
  context: GitContext,
  projectPath: string,
  taskId: string,
  branchName: string,
  proposedName: string,
  check: () => void = () => {},
  save?: (name: string) => void
): Promise<string> {
  return withRepoLock(context, projectPath, async () => {
    check()
    const worktree = taskWorktree(context, taskId)
    const current = (await git(worktree, ['branch', '--show-current'])).stdout.trim()
    let expected = branchName
    if (current === proposedName && current !== branchName) {
      const oldRef = await git(worktree, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], [0, 1])
      if (oldRef.exitCode === 1) {
        expected = proposedName
      }
    }
    await verifyTaskWorktree(projectPath, worktree, expected)
    const gitDir = await realpath((await git(worktree, ['rev-parse', '--absolute-git-dir'])).stdout.trim())
    const commonDir = await commonGitDirectory(worktree)
    if (gitDir === commonDir || await realpath(worktree) !== join(await realpath(dirname(worktree)), taskId)) {
      throw new Error('The task checkout is not a managed linked worktree. No files were changed.')
    }

    // --branch rejects leading options and HEAD, but expands @{-n}. Require
    // literal short names so that Git cannot silently choose a different name.
    const validated = await git(worktree, ['check-ref-format', '--branch', proposedName])
    if (validated.stdout.trim() !== proposedName || proposedName.startsWith('refs/')) {
      throw new Error('Use a literal short branch name.')
    }
    check()
    // The explicit source prevents renaming an unrelated current branch, and
    // lowercase -m refuses to overwrite an existing destination ref.
    if (current !== proposedName) {
      await git(worktree, ['branch', '-m', '--', branchName, proposedName])
    }
    // Do not check cancellation after mutation: callers must receive the name
    // that Git accepted so they can persist it even if the task just stopped.
    try {
      save?.(proposedName)
    } catch (error) {
      if (branchName !== proposedName) {
        try {
          await git(worktree, ['branch', '-m', '--', proposedName, branchName])
        } catch (rollbackError) {
          // If Git cannot restore the original ref, reconcile the accepted
          // name instead. Both paths run before releasing the repository lock.
          try {
            save?.(proposedName)
          } catch (saveError) {
            throw new AggregateError([error, rollbackError, saveError], 'Could not save or restore the task branch')
          }
          return proposedName
        }
      }
      throw error
    }
    return proposedName
  })
}

export async function restackBranch(
  context: GitContext,
  projectPath: string,
  taskId: string,
  branch: string,
  oldBase: string,
  target: { commit: string; branch: string },
  check: () => void,
  save?: (result: FinalizedCheckout) => void
): Promise<FinalizedCheckout> {
  return withRepoLock(context, projectPath, async () => {
    check()
    const worktree = taskWorktree(context, taskId)
    await verifyTaskWorktree(projectPath, worktree, branch)
    if ((await git(worktree, ['status', '--porcelain', '--untracked-files=all'])).stdout.trim()) {
      throw new Error('Commit or stash worktree changes before restacking')
    }
    check()
    const alreadyBased = await git(worktree, ['merge-base', '--is-ancestor', target.commit, 'HEAD'], [0, 1])
    const result = alreadyBased.exitCode === 0 ? alreadyBased : await git(worktree, ['rebase', '--onto', target.commit, oldBase, branch], [0, 1])
    if (result.exitCode !== 0) {
      await git(worktree, ['rebase', '--abort'])
      throw new Error(`Restack conflict. Resolve the changes and retry.\n${result.stderr || result.stdout}`)
    }
    const headCommit = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim()
    const stats = parseNumstat((await git(worktree, ['diff', '--numstat', target.commit, headCommit])).stdout)
    const finalized = { headCommit, ...stats, hasChanges: stats.filesChanged > 0, finisherCommitted: false }
    save?.(finalized)
    return finalized
  })
}

export async function finalizeBranch(
  context: GitContext,
  projectPath: string,
  taskId: string,
  branchName: string,
  _baseBranch: string | undefined,
  baseCommit: string,
  title: string,
  options: FinalizeOptions = {}
): Promise<FinalizedCheckout> {
  const repoRoot = await repositoryRoot(projectPath)
  return withRepoLock(context, repoRoot, async () => {
    options.check?.()
    const worktree = taskWorktree(context, taskId)
    await verifyTaskWorktree(repoRoot, worktree, branchName)
    options.check?.()
    return commitCheckout(worktree, baseCommit, title, options)
  })
}
