import type { PullRequestInfo, PullRequestPreview } from '../shared/types'
import type { GitDeliveryManager } from './git-delivery'
import type { GitHubCredentials } from './github-credentials'
import { GitHubClient } from './github-client'

export class GitHubPullRequests {
  constructor(
    private readonly gitDelivery: Pick<GitDeliveryManager, 'getPullRequestPreview' | 'pushPullRequestBranch'>,
    private readonly credentials: Pick<GitHubCredentials, 'getToken'>,
    private readonly client = new GitHubClient()
  ) {}

  async preview(projectPath: string, branchName: string): Promise<PullRequestPreview> {
    const account = await this.client.account(await this.credentials.getToken())
    const preview = await this.gitDelivery.getPullRequestPreview(projectPath, branchName)
    return { ...preview, account }
  }

  async open(projectPath: string, branchName: string, preview: PullRequestPreview, title: string, description: string): Promise<PullRequestInfo> {
    if (!preview || preview.sourceBranch !== branchName || preview.remote !== 'origin' || !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(preview.repository)) {
      throw new Error('Load the PR preview before opening a pull request.')
    }
    if (!title.trim() || title.trim().length > 256) throw new Error('The PR title must contain 1 to 256 characters.')
    if (description.length > 65_536) throw new Error('The PR description is too long.')
    if (preview.commitCount < 1) throw new Error('There are no commits to propose against this remote branch.')
    const token = await this.credentials.getToken()
    if (await this.client.account(token) !== preview.account) throw new Error('The GitHub account changed. Reopen the PR dialog.')
    await this.gitDelivery.pushPullRequestBranch(projectPath, preview)
    try {
      const existing = await this.client.findPullRequest(token, preview)
      if (existing) return existing
      return await this.client.createPullRequest(token, preview, title.trim(), description)
    } catch (error) {
      // A timeout can arrive after GitHub created the PR. Recover it rather than duplicate it.
      const existing = await this.client.findPullRequest(token, preview).catch(() => null)
      if (existing) return existing
      throw new Error(`The branch was pushed, but the PR could not be confirmed. Retry to check for an existing PR. ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
