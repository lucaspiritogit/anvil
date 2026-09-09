import { expect, test, vi } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { GitHubClient } from '../src/main/github-client'
import { GitHubPRPolling } from '../src/main/github-pr-polling'
import { Store } from '../src/main/store'
import type { Task } from '../src/shared/types'
import { testHome } from './issue-tracker-doubles'

test('recovers persisted PRs and handles caching, stale tasks, credentials, rate limits and shutdown', async () => {
  const database = join(testHome, 'polling.db')
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  let store = new Store(database, options)
  store.addProject({ id: 'project', name: 'Test', path: testHome, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const base: Task = {
    id: 'task', projectId: 'project', title: 'Feature', prompt: 'Feature', agentId: 'codex', agentLabel: 'Codex',
    cwd: testHome, status: 'succeeded', deliveryStatus: 'reviewable', startedAt: 1, endedAt: 2,
    headCommit: 'a'.repeat(40), branchName: 'feature', inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
    filesChanged: 1, additions: 1, deletions: 0
  }
  const link = { repository: 'owner/repo', number: 7, headSha: base.headCommit!, sourceBranch: 'feature', targetBranch: 'main' }
  const add = (id: string, patch: Partial<Task> = {}, number = 7): void => {
    store.addTask({ ...base, ...patch, id })
    store.linkPullRequest(id, { ...link, number, targetBranch: id === 'wrong-target' ? 'other' : 'main' })
  }
  add('task')
  add('sibling')
  add('newer', { headCommit: 'b'.repeat(40) })
  add('running', { status: 'running' })
  add('wrong-target')
  add('closed', {}, 8)
  store.addTask({ ...base, id: 'unlinked' })
  // The association, not an in-memory event, is enough to recover after downtime.
  store.close()
  store = new Store(database, options)
  store.updateTask('running', { status: 'running', deliveryStatus: 'reviewable' })
  let configured = true
  let token = 'test-token'
  let merged = false
  let unchanged = false
  let failure = 0
  let release: (() => void) | undefined
  let blocked: Promise<void> | undefined
  let now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const requests: { number: number; etag?: string; token: string }[] = []
  const errors: string[] = []
  const approved: string[] = []
  const client = new GitHubClient(async (url, init) => {
    const address = new URL(String(url))
    expect(address.origin).toBe('https://api.github.com')
    expect(init?.redirect).toBe('error')
    const number = Number(address.pathname.split('/').at(-1))
    const headers = init?.headers as Record<string, string>
    requests.push({ number, etag: headers['If-None-Match'], token: headers.Authorization })
    if (blocked) await blocked
    if (failure) return new Response('{}', { status: failure, headers: { 'Retry-After': '1200' } })
    if (unchanged && headers['If-None-Match']) return new Response(null, { status: 304 })
    const isMerged = merged && number !== 8
    return Response.json({ number, state: isMerged || number === 8 ? 'closed' : 'open', merged: isMerged,
      merged_at: isMerged ? '2026-09-07T12:00:00Z' : null,
      head: { sha: base.headCommit, ref: 'feature' }, base: { ref: 'main' }
    }, { headers: { ETag: isMerged ? '"merged"' : '"open"' } })
  })
  const credentials = { status: async () => ({ configured }), getToken: async () => token }
  let polling = new GitHubPRPolling(store, credentials, client, (task) => approved.push(task.id), (message) => errors.push(message), 15)
  onTestCleanup(async () => {
    release?.()
    await polling.close()
  })
  try {
    await polling.refresh()
    expect(requests.map((request) => request.number), 'Deduplicate sibling tasks and skip unlinked or newer tasks').toStrictEqual([7, 8])
    expect(approved.length).toBe(0)
    unchanged = true
    await polling.refresh()
    expect(requests[2].etag).toBe('"open"')
    expect(approved.length).toBe(0)
    unchanged = false
    merged = true
    await polling.refresh()
    expect(approved.sort()).toStrictEqual(['sibling', 'task'])
    const reviewedAt = store.getTask('task')!.reviewedAt
    expect(reviewedAt, 'Settlement starts when the app observes the merge').toBe(now)
    for (const id of ['newer', 'running', 'wrong-target', 'closed', 'unlinked']) expect(store.getTask(id)?.deliveryStatus, id).toBe('reviewable')
    unchanged = true
    store.linkPullRequest('unlinked', link)
    await polling.refresh()
    expect(approved.includes('unlinked'), 'A cached merged response can approve a newly linked task after 304').toBeTruthy()
    expect(store.getTask('task')?.reviewedAt).toBe(reviewedAt)

    const beforeFocus = requests.length
    polling.refreshIfStale()
    expect(requests.length, 'Repeated focus events are throttled').toBe(beforeFocus)
    now += 5_001
    polling.refreshIfStale()
    await polling.refresh()
    expect(requests.length > beforeFocus).toBeTruthy()

    unchanged = false
    failure = 429
    const beforeLimit = requests.length
    await polling.refresh()
    expect(requests.length, 'Rate limiting pauses the whole cycle').toBe(beforeLimit + 1)
    now += 60_000
    await polling.refresh()
    expect(requests.length, 'Honor Retry-After across refresh triggers').toBe(beforeLimit + 1)
    expect(errors.length).toBe(1)
    now += 1_200_000
    failure = 0
    await polling.refresh()
    expect(requests.length > beforeLimit + 1).toBeTruthy()

    // Changing credentials invalidates both pending responses and cached ETags.
    add('revoked', {}, 9)
    blocked = new Promise<void>((resolve) => { release = resolve })
    const pending = polling.refresh()
    const coalesced = polling.refresh()
    expect(pending).toBe(coalesced)
    await delay(0)
    configured = false
    const changed = polling.credentialsChanged()
    release?.()
    await changed
    blocked = undefined
    expect(store.getTask('revoked')?.deliveryStatus).toBe('reviewable')
    const beforeMissing = requests.length
    await polling.refresh()
    expect(requests.length).toBe(beforeMissing)
    configured = true
    token = 'replacement-token'
    await polling.credentialsChanged()
    expect(store.getTask('revoked')?.deliveryStatus).toBe('approved')
    expect(requests.slice(beforeMissing).every((request) => !request.etag && request.token === 'Bearer replacement-token')).toBeTruthy()
    await polling.close()

    add('offline-merge', {}, 10)
    polling = new GitHubPRPolling(store, credentials, client, (task) => approved.push(task.id), (message) => errors.push(message), 15)
    const beforeStart = requests.length
    polling.start()
    for (let attempt = 0; attempt < 100 && requests.length < beforeStart + 4; attempt++) await delay(5)
    expect(store.getTask('offline-merge')?.deliveryStatus, 'Startup refresh catches a merge made while Anvil was closed').toBe('approved')
    expect(requests.length >= beforeStart + 4, 'The interval refreshes without a UI trigger').toBeTruthy()
    await polling.close()
    const afterClose = requests.length
    await polling.refresh()
    expect(requests.length).toBe(afterClose)
  } finally {
    release?.()
    await polling.close()
    store.close()
  }
})
