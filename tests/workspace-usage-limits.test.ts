import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import type { AnvilApi } from '@anvil/client-api'
import type { AgentAccountTarget, ClaudeRateLimits, CodexRateLimits, WorkspaceAgentAccount } from '@anvil/protocol/types'
import { emptyWorkspaceUsage, watchWorkspaceUsage, workspaceUsageProviders, type WorkspaceUsageSnapshot } from '../apps/web/src/workspace-usage-limits'
import { ProviderLimits } from '../apps/web/src/components/ProviderLimits'

vi.mock('../apps/web/src/components/ProviderIcon', () => ({
  ProviderIcon: () => null
}))

const codexLimits: CodexRateLimits = {
  rateLimits: {
    limitId: 'codex', limitName: null, rateLimitReachedType: null,
    primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 2_000_000_000 },
    secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 2_000_001_000 }
  }
}
const claudeLimits: ClaudeRateLimits = {
  fiveHour: { usedPercent: 15, resetsAt: 2_000_000_000 },
  weeklyAll: { usedPercent: 35, resetsAt: 2_000_001_000 },
  weeklyFable: { usedPercent: 80, resetsAt: null }
}

function account(workspaceId: string, agentId: AgentAccountTarget['agentId'], status: WorkspaceAgentAccount['status'] = 'connected'): WorkspaceAgentAccount {
  return { workspaceId, agentId, workspaceName: workspaceId, status,
    accounts: status === 'connected' ? [agentId === 'codex' ? 'ChatGPT: person@example.test (plus)' : 'Claude: person@example.test (max)'] : [], busy: false }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
}

function accountsFixture(): {
  api: Pick<AnvilApi['accounts'], 'status' | 'rateLimits' | 'onChanged'>
  emit: (account: WorkspaceAgentAccount) => void
  status: ReturnType<typeof vi.fn<(input: AgentAccountTarget) => Promise<WorkspaceAgentAccount>>>
  rateLimits: ReturnType<typeof vi.fn<(input: AgentAccountTarget) => Promise<CodexRateLimits | ClaudeRateLimits>>>
  unsubscribe: ReturnType<typeof vi.fn>
} {
  const status = vi.fn(async (input: AgentAccountTarget) => account(input.workspaceId, input.agentId))
  const rateLimits = vi.fn(async (input: AgentAccountTarget): Promise<CodexRateLimits | ClaudeRateLimits> => input.agentId === 'claude' ? claudeLimits : codexLimits)
  const handlers = new Set<(account: WorkspaceAgentAccount) => void>()
  const unsubscribe = vi.fn()
  return {
    api: {
      status,
      rateLimits: rateLimits as AnvilApi['accounts']['rateLimits'],
      onChanged: (handler) => {
        handlers.add(handler)
        return () => { handlers.delete(handler); unsubscribe() }
      }
    },
    emit: (next) => { for (const handler of handlers) handler(next) },
    status, rateLimits, unsubscribe
  }
}

test('shows connected Codex and Claude with three independent Claude remaining-use windows', () => {
  const providers = workspaceUsageProviders({ codex: codexLimits, claude: claudeLimits, codexConnected: true, claudeConnected: true })
  expect(providers.map((provider) => provider.id)).toEqual(['codex', 'claude'])
  expect(providers[0].limits[0].remainingPercent).toBe(60)
  expect(providers[1].limits.map((limit) => [limit.label, limit.remainingPercent])).toEqual([
    ['5 hours', 85], ['Current week (all models)', 65], ['Current week (Fable)', 20]
  ])
  expect(providers[1].limits[2].value).toBe('Reset time unavailable')
  expect(providers[1].limits[0].value.startsWith('Resets in ')).toBe(true)
})

test('renders missing Claude windows as unavailable rather than zero usage', () => {
  const providers = workspaceUsageProviders({
    codex: null, codexConnected: false, claude: { ...claudeLimits, weeklyAll: null, weeklyFable: null }, claudeConnected: true
  })
  const markup = renderToStaticMarkup(createElement(ProviderLimits, { providers }))
  expect(markup).toContain('aria-label="Claude usage limits"')
  expect(markup).toContain('85% left')
  expect(markup.match(/role="meter"/g)).toHaveLength(1)
  expect(markup.match(/Unavailable/g)).toHaveLength(2)
  expect(markup).toContain('Current week (Fable)')
  expect(workspaceUsageProviders({ codex: codexLimits, codexConnected: false, claude: claudeLimits, claudeConnected: false })).toEqual([])
})

test('bounds percentages and rejects malformed usage without hiding other windows', () => {
  const providers = workspaceUsageProviders({
    codex: null, codexConnected: false, claudeConnected: true,
    claude: { fiveHour: { usedPercent: -5, resetsAt: Number.MAX_VALUE }, weeklyAll: { usedPercent: 150, resetsAt: null }, weeklyFable: { usedPercent: NaN, resetsAt: null } }
  })
  expect(providers[0].limits.map((limit) => limit.remainingPercent)).toEqual([100, 0, null])
  expect(providers[0].limits[0].value).toBe('Reset time unavailable')
})

test('uses relative days, hours and minutes for both providers with singular units and expired windows', () => {
  const now = Date.parse('2026-10-04T12:00:00Z')
  for (const [remainingSeconds, expected] of [
    [-1, 'Resetting now'], [0, 'Resetting now'], [1, 'Resets in 1 minute'],
    [60, 'Resets in 1 minute'], [61, 'Resets in 2 minutes'],
    [3600, 'Resets in 1 hour'], [7200, 'Resets in 2 hours'],
    [86400, 'Resets in 1 day'], [172800, 'Resets in 2 days']
  ] as const) {
    const resetsAt = now / 1000 + remainingSeconds
    const providers = workspaceUsageProviders({
      codexConnected: true, claudeConnected: true,
      codex: { rateLimits: { ...codexLimits.rateLimits!, secondary: { ...codexLimits.rateLimits!.secondary!, resetsAt } } },
      claude: { fiveHour: { usedPercent: 15, resetsAt }, weeklyAll: null, weeklyFable: null }
    }, now)
    expect(providers[0].limits[0].value).toBe(expected)
    expect(providers[1].limits[0].value).toBe(expected)
  }
})

test('renders only connected provider cards and preserves complete window labels and accessible meters', () => {
  const snapshot = { codex: codexLimits, claude: claudeLimits, codexConnected: true, claudeConnected: true }
  const both = renderToStaticMarkup(createElement(ProviderLimits, { providers: workspaceUsageProviders(snapshot) }))
  expect(both.match(/<section/g)).toHaveLength(2)
  expect(both.match(/role="meter"/g)).toHaveLength(4)
  expect(both).toContain('Current week (all models)')
  expect(both).toContain('Current week (Fable)')
  const onlyClaude = renderToStaticMarkup(createElement(ProviderLimits, {
    providers: workspaceUsageProviders({ ...snapshot, codexConnected: false })
  }))
  expect(onlyClaude.match(/<section/g)).toHaveLength(1)
  expect(onlyClaude).toContain('aria-label="Claude usage limits"')
  expect(onlyClaude).not.toContain('aria-label="Codex usage limits"')
  expect(renderToStaticMarkup(createElement(ProviderLimits, { providers: [] }))).toBe('')
})

test('does not request or display limits for signed-out or API-key accounts', async () => {
  const fixture = accountsFixture()
  fixture.status.mockImplementation(async (input) => input.agentId === 'codex'
    ? { ...account(input.workspaceId, input.agentId), accounts: ['API key'] }
    : account(input.workspaceId, input.agentId, 'signed-out'))
  let latest = emptyWorkspaceUsage()
  const stop = watchWorkspaceUsage('work', fixture.api, (next) => { latest = next })
  await settle()
  expect(fixture.rateLimits).not.toHaveBeenCalled()
  expect(workspaceUsageProviders(latest)).toEqual([])
  fixture.emit(account('work', 'claude'))
  await settle()
  expect(workspaceUsageProviders(latest).map((provider) => provider.id)).toEqual(['claude'])
  expect(fixture.rateLimits).toHaveBeenCalledOnce()
  stop()
})

test('connected providers remain visible with unavailable windows if their limits fail', async () => {
  const fixture = accountsFixture()
  fixture.rateLimits.mockRejectedValue(new Error('Limits unavailable'))
  let latest = emptyWorkspaceUsage()
  const stop = watchWorkspaceUsage('work', fixture.api, (next) => { latest = next })
  await settle()
  const providers = workspaceUsageProviders(latest)
  expect(providers.map((provider) => provider.id)).toEqual(['codex', 'claude'])
  expect(providers.flatMap((provider) => provider.limits).every((limit) => limit.remainingPercent === null)).toBe(true)
  stop()
})

test('loads providers independently and preserves Claude when Codex fails', async () => {
  const fixture = accountsFixture()
  const codex = deferred<CodexRateLimits>()
  fixture.rateLimits.mockImplementation(async (input) => input.agentId === 'codex' ? codex.promise : claudeLimits)
  let latest = emptyWorkspaceUsage()
  const stop = watchWorkspaceUsage('work', fixture.api, (next) => { latest = next })
  await settle()
  expect(latest.codex).toBeNull()
  expect(latest.claude).toEqual(claudeLimits)
  codex.resolve(codexLimits)
  await settle()
  expect(latest.codex).toEqual(codexLimits)
  fixture.rateLimits.mockImplementation(async (input) => {
    if (input.agentId === 'codex') throw new Error('Codex unavailable')
    return claudeLimits
  })
  fixture.emit(account('work', 'codex'))
  await settle()
  expect(latest.codex).toBeNull()
  expect(latest.claude).toEqual(claudeLimits)
  stop()
})

test('refreshes every minute and only after account changes in its workspace', async () => {
  vi.useFakeTimers()
  const fixture = accountsFixture()
  const snapshots: WorkspaceUsageSnapshot[] = []
  const stop = watchWorkspaceUsage('work', fixture.api, (next) => snapshots.push(next))
  await settle()
  expect(fixture.rateLimits).toHaveBeenCalledTimes(2)
  fixture.emit(account('personal', 'claude'))
  await settle()
  expect(fixture.rateLimits).toHaveBeenCalledTimes(2)
  fixture.emit(account('work', 'claude'))
  await settle()
  expect(fixture.rateLimits).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fixture.rateLimits).toHaveBeenCalledTimes(5)
  expect(fixture.status).toHaveBeenCalledTimes(4)
  stop()
  expect(fixture.unsubscribe).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fixture.rateLimits).toHaveBeenCalledTimes(5)
})

test('hides signed-out Claude and ignores limits from the preceding account', async () => {
  const fixture = accountsFixture()
  const pendingLimits = deferred<ClaudeRateLimits>()
  fixture.rateLimits.mockImplementation(async (input) => input.agentId === 'claude' ? pendingLimits.promise : codexLimits)
  let latest = emptyWorkspaceUsage()
  const stop = watchWorkspaceUsage('work', fixture.api, (next) => { latest = next })
  await settle()
  expect(latest.claudeConnected).toBe(true)
  fixture.emit(account('work', 'claude', 'signed-out'))
  pendingLimits.resolve(claudeLimits)
  await settle()
  expect(latest.claudeConnected).toBe(false)
  expect(latest.claude).toBeNull()
  expect(workspaceUsageProviders(latest).map((provider) => provider.id)).toEqual(['codex'])
  stop()
})

test('hides disconnected Codex and ignores its pending limits while retaining connected Claude', async () => {
  const fixture = accountsFixture()
  const pendingLimits = deferred<CodexRateLimits>()
  fixture.rateLimits.mockImplementation(async (input) => input.agentId === 'codex' ? pendingLimits.promise : claudeLimits)
  let latest = emptyWorkspaceUsage()
  const stop = watchWorkspaceUsage('work', fixture.api, (next) => { latest = next })
  await settle()
  expect(latest.codexConnected).toBe(true)
  fixture.emit(account('work', 'codex', 'signed-out'))
  pendingLimits.resolve(codexLimits)
  await settle()
  expect(latest.codexConnected).toBe(false)
  expect(latest.codex).toBeNull()
  expect(workspaceUsageProviders(latest).map((provider) => provider.id)).toEqual(['claude'])
  stop()
})

test('hides stale provider cards when their refreshed account status is unavailable', async () => {
  vi.useFakeTimers()
  const fixture = accountsFixture()
  let latest = emptyWorkspaceUsage()
  const stop = watchWorkspaceUsage('work', fixture.api, (next) => { latest = next })
  await settle()
  expect(workspaceUsageProviders(latest)).toHaveLength(2)
  fixture.status.mockRejectedValue(new Error('Account unavailable'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(workspaceUsageProviders(latest)).toEqual([])
  expect(latest.codex).toBeNull()
  expect(latest.claude).toBeNull()
  stop()
})

test('keeps a new Claude connection when an earlier status request reports signed out', async () => {
  const fixture = accountsFixture()
  const pendingStatus = deferred<WorkspaceAgentAccount>()
  fixture.status.mockReturnValue(pendingStatus.promise)
  let latest = emptyWorkspaceUsage()
  const stop = watchWorkspaceUsage('work', fixture.api, (next) => { latest = next })
  fixture.emit(account('work', 'claude'))
  await settle()
  pendingStatus.resolve(account('work', 'claude', 'signed-out'))
  await settle()
  expect(latest.claudeConnected).toBe(true)
  expect(latest.claude).toEqual(claudeLimits)
  stop()
})

test('keeps a new Codex subscription when an earlier status request reports an API key', async () => {
  const fixture = accountsFixture()
  const pendingStatus = deferred<WorkspaceAgentAccount>()
  fixture.status.mockImplementation(async (input) => input.agentId === 'codex' ? pendingStatus.promise : account(input.workspaceId, input.agentId))
  let latest = emptyWorkspaceUsage()
  const stop = watchWorkspaceUsage('work', fixture.api, (next) => { latest = next })
  fixture.emit(account('work', 'codex'))
  await settle()
  pendingStatus.resolve({ ...account('work', 'codex'), accounts: ['API key'] })
  await settle()
  expect(latest.codexConnected).toBe(true)
  expect(latest.codex).toEqual(codexLimits)
  stop()
})

test('discards both providers after workspace cleanup', async () => {
  const fixture = accountsFixture()
  const pendingCodex = deferred<CodexRateLimits>()
  const pendingClaude = deferred<ClaudeRateLimits>()
  fixture.rateLimits.mockImplementation(async (input) => input.agentId === 'claude' ? pendingClaude.promise : pendingCodex.promise)
  const changes = vi.fn()
  const stop = watchWorkspaceUsage('work', fixture.api, changes)
  await settle()
  stop()
  const count = changes.mock.calls.length
  pendingCodex.resolve(codexLimits)
  pendingClaude.resolve(claudeLimits)
  await settle()
  expect(changes).toHaveBeenCalledTimes(count)
})
