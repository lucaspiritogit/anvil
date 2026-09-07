import type { PullRequestInfo, PullRequestPreview } from '../shared/types'
import { isGitHubPullRequestUrl } from './github-repository'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub returned an invalid response.')
  return value as Record<string, unknown>
}

export class GitHubClient {
  constructor(private readonly requestFetch: typeof fetch = fetch) {}

  private async request(token: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this.requestFetch(`https://api.github.com${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Anvil',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    } catch {
      throw new Error('Could not reach GitHub. Check your connection and try again.')
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'GitHub rejected the token. Replace it in Settings.',
        403: 'GitHub denied access. Check token permissions, organization authorization, and rate limits.',
        404: 'GitHub repository or branch not found, or the token cannot access it.',
        422: 'GitHub could not create the PR. Check the branches, title, permissions, and whether a PR already exists.'
      }
      throw new Error(messages[response.status] ?? `GitHub request failed with HTTP ${response.status}.`)
    }
    try { return await response.json() } catch { throw new Error('GitHub returned an invalid response.') }
  }

  async account(token: string): Promise<string> {
    const user = object(await this.request(token, '/user'))
    if (user.type !== 'User' || typeof user.login !== 'string' || !/^[a-zA-Z0-9-]+$/.test(user.login)) {
      throw new Error('Use a personal GitHub token belonging to your user account.')
    }
    return user.login
  }

  private pullRequest(value: unknown, repository: string, existing: boolean): PullRequestInfo {
    const response = object(value)
    const user = object(response.user)
    const head = object(response.head)
    const base = object(response.base)
    if (typeof response.number !== 'number' || !Number.isSafeInteger(response.number) || response.number < 1 ||
      typeof response.html_url !== 'string' || !isGitHubPullRequestUrl(response.html_url) ||
      response.html_url.toLowerCase() !== `https://github.com/${repository}/pull/${response.number}`.toLowerCase() ||
      typeof response.title !== 'string' || typeof user.login !== 'string' || typeof head.ref !== 'string' || typeof base.ref !== 'string' ||
      (response.body !== null && typeof response.body !== 'string')) {
      throw new Error('GitHub returned invalid PR details.')
    }
    return {
      number: response.number, url: response.html_url, title: response.title, description: response.body ?? '',
      author: user.login, sourceBranch: head.ref, targetBranch: base.ref, existing
    }
  }

  async findPullRequest(token: string, preview: PullRequestPreview): Promise<PullRequestInfo | null> {
    const owner = preview.repository.split('/')[0]
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${preview.sourceBranch}`, base: preview.targetBranch, per_page: '1' })
    const result = await this.request(token, `/repos/${preview.repository}/pulls?${query}`)
    if (!Array.isArray(result)) throw new Error('GitHub returned an invalid PR list.')
    return result.length ? this.pullRequest(result[0], preview.repository, true) : null
  }

  async createPullRequest(token: string, preview: PullRequestPreview, title: string, description: string): Promise<PullRequestInfo> {
    const result = await this.request(token, `/repos/${preview.repository}/pulls`, {
      title, body: description, head: preview.sourceBranch, base: preview.targetBranch
    })
    return this.pullRequest(result, preview.repository, false)
  }
}
