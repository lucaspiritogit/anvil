import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { TaskMergePreview, TaskPushPreview } from '../../shared/types'
import type { GitContext, MergeConflictResult, MergeResult } from './types'
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
): Promise<MergeResult> {
  const repoRoot = await repositoryRoot(projectPath)
  return withRepoLock(context, repoRoot, async () => {
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
        let conflict: MergeConflictResult | undefined
        try {
          const conflictedFiles = (await git(repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout
            .split('\0').filter(Boolean)
          const head = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
          if (conflictedFiles.length > 0 && mergeHead.stdout.trim() === expected.sourceCommit && head === expected.targetCommit) {
            conflict = {
              status: 'conflicted',
              repositoryRoot: repoRoot,
              mergeHeadCommit: mergeHead.stdout.trim(),
              conflictedFiles
            }
          }
        } catch {}
        if (conflict) {
          return conflict
        }
        try {
          await git(repoRoot, ['merge', '--abort'])
        } catch (abortError) {
          throw new Error(`Merge failed: ${error instanceof Error ? error.message : String(error)}. Could not abort the merge: ${abortError instanceof Error ? abortError.message : String(abortError)}`)
        }
      }
      throw new Error(`Merge failed. The task was not merged: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { status: 'merged', commit: (await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim() }
  })
}

export async function validateMergeConflict(
  projectPath: string,
  expected: Pick<MergeConflictResult, 'repositoryRoot' | 'mergeHeadCommit'> & Omit<TaskMergePreview, 'commitCount'>
): Promise<string[]> {
  const repoRoot = await repositoryRoot(projectPath)
  if (repoRoot !== expected.repositoryRoot) throw new Error('The merge conflict belongs to a different repository checkout.')
  const [branch, head, source, mergeHead, unmerged] = await Promise.all([
    git(repoRoot, ['branch', '--show-current']),
    git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(repoRoot, ['rev-parse', '--verify', `refs/heads/${expected.sourceBranch}^{commit}`]),
    git(repoRoot, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [0, 1]),
    git(repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z'])
  ])
  const conflictedFiles = unmerged.stdout.split('\0').filter(Boolean)
  if (branch.stdout.trim() !== expected.targetBranch || head.stdout.trim() !== expected.targetCommit ||
      source.stdout.trim() !== expected.sourceCommit || mergeHead.exitCode !== 0 ||
      mergeHead.stdout.trim() !== expected.mergeHeadCommit || expected.mergeHeadCommit !== expected.sourceCommit ||
      conflictedFiles.length === 0) {
    throw new Error('The paused merge no longer matches this task. Inspect the repository before continuing.')
  }
  return conflictedFiles
}

async function originPushUrl(projectPath: string): Promise<string> {
  let output: string
  try {
    output = (await git(projectPath, ['remote', 'get-url', '--push', '--all', 'origin'])).stdout
  } catch {
    throw new Error('Configure exactly one origin push URL before pushing this branch.')
  }
  const urls = output.trim().split(/\r?\n/).filter(Boolean)
  if (urls.length !== 1) {
    throw new Error('Configure exactly one origin push URL before pushing this branch.')
  }
  return urls[0]
}

function remoteUrlHash(remoteUrl: string): string {
  return createHash('sha256').update(remoteUrl).digest('hex')
}

async function remoteBranchCommit(
  context: GitContext,
  projectPath: string,
  remoteUrl: string,
  targetBranch: string
): Promise<string | null> {
  let result: Awaited<ReturnType<GitContext['remoteGit']>>
  try {
    result = await context.remoteGit(
      projectPath,
      ['ls-remote', '--exit-code', '--refs', '--', remoteUrl, `refs/heads/${targetBranch}`],
      [0, 2],
      { GIT_TERMINAL_PROMPT: '0' }
    )
  } catch (error) {
    throw new Error(`Could not read ${targetBranch} from origin before pushing: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (result.exitCode === 2 || !result.stdout.trim()) return null
  const lines = result.stdout.trim().split(/\r?\n/)
  const [commit, ref, ...extra] = lines[0].trim().split(/\s+/)
  if (lines.length !== 1 || extra.length || ref !== `refs/heads/${targetBranch}` || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(commit)) {
    throw new Error(`Origin returned an ambiguous ${targetBranch} branch. Check the remote before pushing.`)
  }
  return commit
}

/** Snapshot the checked-out target and its configured origin branch without mutating either repository. */
export async function getPushPreview(
  context: GitContext,
  projectPath: string,
  expectedTargetBranch?: string,
  requiredCommit?: string
): Promise<TaskPushPreview> {
  const repoRoot = await repositoryRoot(projectPath)
  const targetBranch = (await git(repoRoot, ['branch', '--show-current'])).stdout.trim()
  if (!targetBranch) throw new Error('Check out a branch in the project before pushing.')
  await git(repoRoot, ['check-ref-format', `refs/heads/${targetBranch}`])
  if (expectedTargetBranch && targetBranch !== expectedTargetBranch) {
    throw new Error(`The checked-out target changed from ${expectedTargetBranch} to ${targetBranch}. Refresh the push details.`)
  }
  const targetCommit = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (requiredCommit) {
    const containsTask = await git(repoRoot, ['merge-base', '--is-ancestor', requiredCommit, targetCommit], [0, 1])
    if (containsTask.exitCode !== 0) {
      throw new Error('Check out the target branch containing this task\'s merged changes before pushing.')
    }
  }
  const remoteUrl = await originPushUrl(repoRoot)
  const remoteTargetCommit = await remoteBranchCommit(context, repoRoot, remoteUrl, targetBranch)
  if (remoteUrlHash(await originPushUrl(repoRoot)) !== remoteUrlHash(remoteUrl)) {
    throw new Error('The origin push URL changed while loading the push details. Refresh and try again.')
  }
  return { targetBranch, targetCommit, remote: 'origin', remoteTargetCommit, remoteUrlHash: remoteUrlHash(remoteUrl) }
}

/** Push only the checked-out branch tip the user confirmed, using a non-force explicit refspec. */
export async function push(
  context: GitContext,
  projectPath: string,
  expected: TaskPushPreview,
  requiredCommit?: string,
  check: () => void = () => {}
): Promise<void> {
  const repoRoot = await repositoryRoot(projectPath)
  await withRepoLock(context, repoRoot, async () => {
    const current = await getPushPreview(context, repoRoot, expected.targetBranch, requiredCommit)
    if (!expected || current.targetBranch !== expected.targetBranch || current.targetCommit !== expected.targetCommit ||
      current.remote !== expected.remote || current.remoteTargetCommit !== expected.remoteTargetCommit ||
      current.remoteUrlHash !== expected.remoteUrlHash) {
      throw new Error('The target branch or origin changed since the push preview was loaded. Refresh and try again.')
    }
    const remoteUrl = await originPushUrl(repoRoot)
    if (remoteUrlHash(remoteUrl) !== expected.remoteUrlHash) {
      throw new Error('The origin push URL changed since the push preview was loaded. Refresh and try again.')
    }
    check()
    try {
      await context.remoteGit(
        repoRoot,
        ['push', '--porcelain', '--', remoteUrl, `${expected.targetCommit}:refs/heads/${expected.targetBranch}`],
        [0],
        { GIT_TERMINAL_PROMPT: '0' }
      )
    } catch (error) {
      throw new Error(`Origin rejected the push to ${expected.targetBranch}. Fetch and reconcile remote changes, then try again: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
