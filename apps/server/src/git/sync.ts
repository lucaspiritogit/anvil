import type { BranchSyncStatus } from '@anvil/protocol/types'
import type { GitContext } from './types'
import { git } from './command'
import { originPushUrl, remoteBranchCommit } from './merge'
import { repositoryRoot, withRepoLock } from './repository'

export interface BranchSyncTarget {
  branch: string
  localCommit: string
  remoteCommit: string
}

function nulSeparated(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

async function currentBranch(repoRoot: string): Promise<{ branch: string; localCommit: string }> {
  const branch = (await git(repoRoot, ['branch', '--show-current'])).stdout.trim()
  if (!branch) throw new Error('Check out a branch in the project before syncing with origin.')
  await git(repoRoot, ['check-ref-format', `refs/heads/${branch}`])
  const localCommit = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  return { branch, localCommit }
}

async function locallyChangedPaths(repoRoot: string): Promise<Set<string>> {
  const [tracked, untracked] = await Promise.all([
    git(repoRoot, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']),
    git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])
  return new Set([...nulSeparated(tracked.stdout), ...nulSeparated(untracked.stdout)])
}

export async function getSyncStatus(context: GitContext, projectPath: string): Promise<BranchSyncStatus> {
  const repoRoot = await repositoryRoot(projectPath)
  const { branch, localCommit } = await currentBranch(repoRoot)
  const remoteUrl = await originPushUrl(repoRoot)
  if (!await remoteBranchCommit(context, repoRoot, remoteUrl, branch)) {
    return { branch, localCommit, remoteCommit: null, ahead: 0, behind: 0, overlappingPaths: [] }
  }
  const trackingRef = `refs/remotes/origin/${branch}`
  try {
    await context.remoteGit(
      repoRoot,
      ['fetch', '--no-tags', '--no-write-fetch-head', '--', remoteUrl, `+refs/heads/${branch}:${trackingRef}`],
      [0],
      { GIT_TERMINAL_PROMPT: '0' }
    )
  } catch (error) {
    throw new Error(`Could not fetch ${branch} from origin: ${error instanceof Error ? error.message : String(error)}`)
  }
  const remoteCommit = (await git(repoRoot, ['rev-parse', '--verify', `${trackingRef}^{commit}`])).stdout.trim()
  const [ahead, behind] = (await git(repoRoot, ['rev-list', '--left-right', '--count', `${localCommit}...${remoteCommit}`]))
    .stdout.trim().split(/\s+/).map(Number)
  if (!behind) return { branch, localCommit, remoteCommit, ahead, behind, overlappingPaths: [] }
  const [incoming, local] = await Promise.all([
    git(repoRoot, ['diff', '--name-only', '--no-renames', '-z', `${localCommit}...${remoteCommit}`, '--']),
    locallyChangedPaths(repoRoot)
  ])
  const overlappingPaths = nulSeparated(incoming.stdout).filter((path) => local.has(path)).sort()
  return { branch, localCommit, remoteCommit, ahead, behind, overlappingPaths }
}

export async function pull(
  context: GitContext,
  projectPath: string,
  expected: BranchSyncTarget,
  check: () => void = () => {}
): Promise<BranchSyncStatus> {
  const repoRoot = await repositoryRoot(projectPath)
  return withRepoLock(context, repoRoot, async () => {
    const { branch, localCommit } = await currentBranch(repoRoot)
    if (branch !== expected.branch || localCommit !== expected.localCommit) {
      throw new Error('The checked-out branch changed since origin was checked. Refresh and try again.')
    }
    const tracking = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], [0, 1])
    if (tracking.stdout.trim() !== expected.remoteCommit) {
      throw new Error(`origin/${branch} changed since it was checked. Refresh and try again.`)
    }
    const fastForward = await git(repoRoot, ['merge-base', '--is-ancestor', localCommit, expected.remoteCommit], [0, 1])
    if (fastForward.exitCode !== 0) {
      throw new Error(`${branch} has local commits that are not on origin/${branch}. Reconcile the diverged branches before pulling.`)
    }
    check()
    try {
      await git(repoRoot, ['merge', '--ff-only', '--no-stat', expected.remoteCommit])
    } catch (error) {
      throw new Error(`Could not fast-forward ${branch} to origin/${branch}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { branch, localCommit: expected.remoteCommit, remoteCommit: expected.remoteCommit, ahead: 0, behind: 0, overlappingPaths: [] }
  })
}
