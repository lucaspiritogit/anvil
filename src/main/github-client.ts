import type { PullRequestInfo, PullRequestPreview } from '../shared/types'
import { parsePullRequestMerged, type PullRequestMerged } from '../shared/github-pull-request-state'
import { isGitHubPullRequestUrl } from './github-repository'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub returned an invalid response.')
  return value as Record<string, unknown>
}

export class GitHubRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAt?: number) { super(message) }
}

export interface PullRequestState {
  etag?: string
  merged: PullRequestMerged | null
}

export class GitHubClient {
  constructor(private readonly requestFetch: typeof fetch = fetch) {}

  private async response(token: string, path: string, body?: unknown, options: { etag?: string; signal?: AbortSignal } = {}): Promise<Response> {
    let response: Response
    try {
      response = await this.requestFetch(`https://api.github.com${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Anvil',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.etag ? { 'If-None-Match': options.etag } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    } catch {
      throw new Error('Could not reach GitHub. Check your connection and try again.')
    }
    if (response.status === 304 && options.etag) return response
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'GitHub rejected the token. Replace it in Settings.',
        403: 'GitHub denied access. Check token permissions, organization authorization, and rate limits.',
        404: 'GitHub repository or branch not found, or the token cannot access it.',
        422: 'GitHub could not create the PR. Check the branches, title, permissions, and whether a PR already exists.'
      }
      const retryAfter = response.headers.get('retry-after')
      const reset = response.headers.get('x-ratelimit-remaining') === '0' ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : NaN
      const retryAt = retryAfter ? (/^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter)) : reset
      await response.body?.cancel()
      throw new GitHubRequestError(messages[response.status] ?? `GitHub request failed with HTTP ${response.status}.`, response.status,
        Number.isFinite(retryAt) ? retryAt : undefined)
    }
    return response
  }

  private async request(token: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.response(token, path, body)
    try { return await response.json() } catch { throw new Error('GitHub returned an invalid response.') }
  }

  async pullRequestState(token: string, repository: string, number: number, options: { etag?: string; signal?: AbortSignal } = {}): Promise<PullRequestState | null> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid PR association')
    const response = await this.response(token, `/repos/${repository}/pulls/${number}`, undefined, options)
    if (response.status === 304) return null
    const data = object(await response.json())
    if (data.number !== number || !['open', 'closed'].includes(String(data.state)) || typeof data.merged !== 'boolean') {
      throw new Error('GitHub returned invalid PR state.')
    }
    const etag = response.headers.get('etag') ?? undefined
    if (!data.merged) return { etag, merged: null }
    if (data.state !== 'closed') throw new Error('GitHub returned inconsistent PR state.')
    const head = object(data.head)
    const base = object(data.base)
    return { etag, merged: parsePullRequestMerged({
      repository, number, headSha: head.sha, sourceBranch: head.ref, targetBranch: base.ref, mergedAt: data.merged_at
    }) }
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
