import { randomUUID } from 'node:crypto'
import { githubRepository } from '../../shared/github-repository'
import type { PullRequestGitPreview } from '../../shared/types'
import type { GitContext } from './types'
import { git } from './command'
import { getMergePreview } from './merge'
import { withRepoLock, repositoryRoot } from './repository'

export async function getPullRequestPreview(
  context: GitContext,
  projectPath: string,
  branchName: string
): Promise<PullRequestGitPreview> {
  const remoteUrl = await pullRequestRemote(projectPath)
  const repository = githubRepository(remoteUrl)
  const local = await getMergePreview(projectPath, branchName)
  const temporaryRef = `refs/anvil/pr-preview/${randomUUID()}`
  try {
    // Fetch into a private ref, not the user's checkout, index, or FETCH_HEAD.
    await context.remoteGit(projectPath, ['fetch', '--no-tags', '--no-write-fetch-head', '--', remoteUrl, `refs/heads/${local.targetBranch}:${temporaryRef}`], [0], { GIT_TERMINAL_PROMPT: '0' })
    const remoteTargetCommit = (await git(projectPath, ['rev-parse', '--verify', temporaryRef])).stdout.trim()
    const commitCount = Number((await git(projectPath, ['rev-list', '--count', `${remoteTargetCommit}..${local.sourceCommit}`])).stdout.trim())
    return { ...local, repository, remote: 'origin', remoteTargetCommit, commitCount }
  } finally {
    await git(projectPath, ['update-ref', '-d', temporaryRef])
  }
}

async function pullRequestRemote(projectPath: string): Promise<string> {
  const remotes = (await git(projectPath, ['remote', 'get-url', '--push', '--all', 'origin'])).stdout.trim().split(/\r?\n/)
  if (remotes.length !== 1 || !remotes[0]) {
    throw new Error('Configure exactly one origin push URL before opening a PR.')
  }
  githubRepository(remotes[0])
  return remotes[0]
}

export async function pushPullRequestBranch(
  context: GitContext,
  projectPath: string,
  expected: PullRequestGitPreview,
  check: () => void = () => {}
): Promise<void> {
  const repoRoot = await repositoryRoot(projectPath)
  await withRepoLock(context, repoRoot, async () => {
    const current = await getPullRequestPreview(context, repoRoot, expected.sourceBranch)
    if (current.repository !== expected.repository || current.sourceCommit !== expected.sourceCommit ||
      current.targetBranch !== expected.targetBranch || current.targetCommit !== expected.targetCommit ||
      current.remoteTargetCommit !== expected.remoteTargetCommit || current.commitCount !== expected.commitCount) {
      throw new Error('The branches or remote changed. Close this dialog and open PR again to refresh the preview.')
    }
    const remoteUrl = await pullRequestRemote(repoRoot)
    if (githubRepository(remoteUrl) !== expected.repository) {
      throw new Error('The origin remote changed. Reopen the PR dialog.')
    }
    // Explicit refspec, no force, no credential overrides, no author changes.
    check()
    await context.remoteGit(repoRoot, ['push', '--porcelain', '--', remoteUrl, `${expected.sourceCommit}:refs/heads/${expected.sourceBranch}`], [0], { GIT_TERMINAL_PROMPT: '0' })
  })
}
