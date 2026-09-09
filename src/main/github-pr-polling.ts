import { GitHubClient, GitHubRequestError, type PullRequestState } from './github-client'
import type { GitHubCredentials } from './github-credentials'
import type { Store } from './store'
import type { Task } from '../shared/types'
import type { PullRequestMerged } from '../shared/github-pull-request-state'

/** Refresh GitHub state directly; a new app session catches up after time offline. */
export class GitHubPRPolling {
  private timer?: ReturnType<typeof setInterval>
  private inFlight?: Promise<void>
  private controller?: AbortController
  private closed = false
  private generation = 0
  private lastStartedAt = 0
  private blockedUntil = 0
  private readonly cache = new Map<string, PullRequestState>()
  private readonly retries = new Map<string, { failures: number; after: number }>()

  constructor(
    private readonly store: Pick<Store, 'getPullRequestsToRefresh' | 'approveMergedPullRequest'>,
    private readonly credentials: Pick<GitHubCredentials, 'status' | 'getToken'>,
    private readonly client: Pick<GitHubClient, 'pullRequestState'>,
    private readonly onApproved: (task: Task, merge: PullRequestMerged) => void,
    private readonly reportError: (message: string) => void,
    private readonly intervalMs = 60_000
  ) {}

  start(): void {
    if (this.timer || this.closed) return
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, this.intervalMs)
    this.timer.unref()
  }

  refreshIfStale(): void {
    if (Date.now() - this.lastStartedAt >= 5_000) void this.refresh()
  }

  async credentialsChanged(): Promise<void> {
    this.generation += 1
    this.controller?.abort()
    this.cache.clear()
    this.retries.clear()
    this.blockedUntil = 0
    await this.inFlight
    await this.refresh()
  }

  refresh(): Promise<void> {
    if (this.closed || Date.now() < this.blockedUntil) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    this.lastStartedAt = Date.now()
    this.controller = new AbortController()
    this.inFlight = this.poll(this.generation, this.controller.signal).finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    this.controller?.abort()
    await this.inFlight
  }

  private async poll(generation: number, signal: AbortSignal): Promise<void> {
    try {
      if (!(await this.credentials.status()).configured) return
      const token = await this.credentials.getToken()
      if (signal.aborted || generation !== this.generation) return
      const links = this.store.getPullRequestsToRefresh()
      const pending = new Map(links.map((link) => [`${link.repository}#${link.number}`, link]))
      for (const key of this.cache.keys()) if (!pending.has(key)) this.cache.delete(key)
      for (const key of this.retries.keys()) if (!pending.has(key)) this.retries.delete(key)
      for (const [key, link] of pending) {
        if (signal.aborted || generation !== this.generation) return
        if (Date.now() < (this.retries.get(key)?.after ?? 0)) continue
        try {
          const result = await this.client.pullRequestState(token, link.repository, link.number, { etag: this.cache.get(key)?.etag, signal })
          if (signal.aborted || generation !== this.generation) return
          const state = result ?? this.cache.get(key)
          if (!state) throw new Error('GitHub returned an unchanged PR without cached state.')
          this.cache.set(key, state)
          this.retries.delete(key)
          if (state.merged) {
            for (const task of this.store.approveMergedPullRequest(state.merged)) this.onApproved(task, state.merged)
          }
        } catch (error) {
          if (signal.aborted || generation !== this.generation) return
          const failures = (this.retries.get(key)?.failures ?? 0) + 1
          const delay = error instanceof GitHubRequestError && [401, 403, 404].includes(error.status)
            ? 10 * 60_000 : Math.min(60_000 * 2 ** Math.min(failures - 1, 4), 15 * 60_000)
          const after = Math.max(Date.now() + delay, error instanceof GitHubRequestError ? error.retryAt ?? 0 : 0)
          this.retries.set(key, { failures, after })
          if (failures === 1) this.reportError(error instanceof Error ? error.message : 'Could not refresh GitHub PR status.')
          if (error instanceof GitHubRequestError && [401, 403, 429].includes(error.status)) {
            this.blockedUntil = after
            return
          }
        }
      }
    } catch {
      if (!signal.aborted && generation === this.generation) {
        this.blockedUntil = Date.now() + 60_000
        this.reportError('Could not access GitHub credentials. PR status will be retried.')
      }
    }
  }
}
