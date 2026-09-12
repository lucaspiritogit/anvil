import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { TaskMergePreview } from '../../shared/types'
import type { GitContext } from './types'
import { git } from './command'
import { withRepoLock, repositoryRoot } from './repository'

export async function getMergePreview(projectPath: string, branchName: string): Promise<TaskMergePreview> {
  await git(projectPath, ['check-ref-format', `refs/heads/${branchName}`])
  const targetBranch = (await git(projectPath, ['branch', '--show-current'])).stdout.trim()
  if (!targetBranch) {
    throw new Error('Check out a branch in the project before merging this task.')
  }
  if (targetBranch === branchName) {
    throw new Error('The task branch is checked out in the project. Check out the destination branch first.')
  }

  const sourceCommit = (await git(projectPath, ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`])).stdout.trim()
  const targetCommit = (await git(projectPath, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
  const commitCount = Number((await git(projectPath, ['rev-list', '--count', `${targetCommit}..${sourceCommit}`])).stdout.trim())
  return { sourceBranch: branchName, targetBranch, sourceCommit, targetCommit, commitCount }
}

/** Merge only the branch tips the user confirmed, without switching their checkout. */
export async function merge(
  context: GitContext,
  projectPath: string,
  branchName: string,
  expected: TaskMergePreview,
  check: () => void = () => {}
): Promise<void> {
  const repoRoot = await repositoryRoot(projectPath)
  await withRepoLock(context, repoRoot, async () => {
    const current = await getMergePreview(repoRoot, branchName)
    if (!expected || current.sourceBranch !== expected.sourceBranch || current.targetBranch !== expected.targetBranch ||
      current.sourceCommit !== expected.sourceCommit || current.targetCommit !== expected.targetCommit ||
      current.commitCount !== expected.commitCount) {
      throw new Error('The branches changed since the merge preview was loaded. Close this dialog and merge again.')
    }

    for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
      const operationPath = (await git(repoRoot, ['rev-parse', '--git-path', operation])).stdout.trim()
      if (existsSync(isAbsolute(operationPath) ? operationPath : join(repoRoot, operationPath))) {
        throw new Error('Finish or abort the existing Git operation before merging this task.')
      }
    }
    const dirty = (await git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()
    if (dirty) {
      throw new Error('Commit or stash local changes in the project before merging this task.')
    }

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
      throw new Error(`Merge failed. The task was not merged: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
