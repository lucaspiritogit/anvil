import type { AnvilApi } from '@anvil/client-api'
import type { ClaudeRateLimits, CodexRateLimits, WorkspaceAgentAccount } from '@anvil/protocol/types'
import type { ProviderLimit, ProviderLimitsData } from './components/ProviderLimits'

export interface WorkspaceUsageSnapshot {
  codex: CodexRateLimits | null
  claude: ClaudeRateLimits | null
  codexConnected: boolean
  claudeConnected: boolean
}

export function emptyWorkspaceUsage(): WorkspaceUsageSnapshot {
  return { codex: null, claude: null, codexConnected: false, claudeConnected: false }
}

function resetLabel(timestamp: number | null, now: number): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return 'Reset time unavailable'
  const remainingMilliseconds = timestamp * 1000 - now
  if (!Number.isFinite(remainingMilliseconds)) return 'Reset time unavailable'
  if (remainingMilliseconds <= 0) return 'Resetting now'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const unit = remainingMilliseconds >= day ? 'day' : remainingMilliseconds >= hour ? 'hour' : 'minute'
  const duration = unit === 'day' ? day : unit === 'hour' ? hour : minute
  const count = Math.ceil(remainingMilliseconds / duration)
  return `Resets in ${count} ${unit}${count === 1 ? '' : 's'}`
}

function limitRow(label: string, limit: { usedPercent: number; resetsAt: number | null } | null, now: number): ProviderLimit {
  if (!limit || !Number.isFinite(limit.usedPercent)) return { label, value: 'Unavailable', remainingPercent: null }
  return {
    label,
    value: resetLabel(limit.resetsAt, now),
    remainingPercent: Math.max(0, Math.min(100, 100 - limit.usedPercent))
  }
}

export function workspaceUsageProviders(snapshot: WorkspaceUsageSnapshot, now: number = Date.now()): ProviderLimitsData[] {
  const providers: ProviderLimitsData[] = []
  const codex = snapshot.codex?.rateLimitsByLimitId?.codex ?? snapshot.codex?.rateLimits
  const weekly = codex?.secondary ?? codex?.primary ?? null
  if (snapshot.codexConnected) {
    providers.push({
      id: 'codex', name: 'ChatGPT', company: 'OpenAI', ariaLabel: 'Codex usage limits',
      limits: [limitRow('Weekly', weekly, now)]
    })
  }
  if (snapshot.claudeConnected) {
    providers.push({
      id: 'claude', name: 'Claude', company: 'Anthropic', ariaLabel: 'Claude usage limits',
      limits: [
        limitRow('5 hours', snapshot.claude?.fiveHour ?? null, now),
        limitRow('Current week (all models)', snapshot.claude?.weeklyAll ?? null, now),
        limitRow('Current week (Fable)', snapshot.claude?.weeklyFable ?? null, now)
      ]
    })
  }
  return providers
}

export function watchWorkspaceUsage(
  workspaceId: string,
  accounts: Pick<AnvilApi['accounts'], 'status' | 'rateLimits' | 'onChanged'>,
  onChange: (snapshot: WorkspaceUsageSnapshot) => void
): () => void {
  let active = true
  let codexRequest = 0
  let claudeRequest = 0
  let snapshot = emptyWorkspaceUsage()
  const publish = (patch: Partial<WorkspaceUsageSnapshot>): void => {
    if (!active) return
    snapshot = { ...snapshot, ...patch }
    onChange(snapshot)
  }
  const loadCodexLimits = (request: number): void => {
    void accounts.rateLimits({ workspaceId, agentId: 'codex' }).then((codex) => {
      if (active && request === codexRequest) publish({ codex })
    }).catch(() => {
      if (active && request === codexRequest) publish({ codex: null })
    })
  }
  const applyCodexAccount = (account: WorkspaceAgentAccount, request: number): void => {
    if (!active || request !== codexRequest) return
    const connected = account.status === 'connected' && account.accounts.some((label) => /^ChatGPT(?:[: ]|$)/.test(label))
    if (!connected) {
      publish({ codexConnected: false, codex: null })
      return
    }
    publish({ codexConnected: true })
    loadCodexLimits(request)
  }
  const loadCodex = (): void => {
    const request = ++codexRequest
    void accounts.status({ workspaceId, agentId: 'codex' }).then((account) => {
      applyCodexAccount(account, request)
    }).catch(() => {
      if (active && request === codexRequest) publish({ codexConnected: false, codex: null })
    })
  }
  const loadClaudeLimits = (request: number): void => {
    void accounts.rateLimits({ workspaceId, agentId: 'claude' }).then((claude) => {
      if (active && request === claudeRequest) publish({ claude })
    }).catch(() => {
      if (active && request === claudeRequest) publish({ claude: null })
    })
  }
  const applyClaudeAccount = (account: WorkspaceAgentAccount, request: number): void => {
    if (!active || request !== claudeRequest) return
    if (account.status !== 'connected') {
      publish({ claudeConnected: false, claude: null })
      return
    }
    publish({ claudeConnected: true })
    loadClaudeLimits(request)
  }
  const loadClaude = (): void => {
    const request = ++claudeRequest
    void accounts.status({ workspaceId, agentId: 'claude' }).then((account) => {
      applyClaudeAccount(account, request)
    }).catch(() => {
      if (active && request === claudeRequest) publish({ claudeConnected: false, claude: null })
    })
  }
  const off = accounts.onChanged((account) => {
    if (account.workspaceId !== workspaceId) return
    if (account.agentId === 'codex') applyCodexAccount(account, ++codexRequest)
    if (account.agentId === 'claude') applyClaudeAccount(account, ++claudeRequest)
  })
  onChange(snapshot)
  loadCodex()
  loadClaude()
  const timer = setInterval(() => {
    loadCodex()
    loadClaude()
  }, 60_000)
  return () => {
    active = false
    clearInterval(timer)
    off()
  }
}
