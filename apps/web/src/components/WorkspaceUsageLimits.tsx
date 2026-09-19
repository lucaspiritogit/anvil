import { memo, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CodexRateLimitWindow, CodexRateLimits } from '@anvil/protocol/types'
import { useStore } from '../state/store'
import { ProviderLimits, type ProviderLimitsData } from './ProviderLimits'

function weeklyLimit(limits: CodexRateLimits): CodexRateLimitWindow | null {
  const codex = limits.rateLimitsByLimitId?.codex ?? limits.rateLimits
  return codex?.secondary ?? codex?.primary ?? null
}

function resetLabel(timestamp: number): string {
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(timestamp * 1000))}`
}

export const WorkspaceUsageLimits = memo(function WorkspaceUsageLimits({ className }: { className?: string }): JSX.Element | null {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const [limitWindow, setLimitWindow] = useState<CodexRateLimitWindow | null>(null)

  useEffect(() => {
    let active = true
    const load = (): void => {
      if (!workspaceId) return
      void window.anvil.accounts.rateLimits({ workspaceId, agentId: 'codex' }).then((limits) => {
        if (active) setLimitWindow(weeklyLimit(limits))
      }).catch(() => {
        if (active) setLimitWindow(null)
      })
    }
    load()
    const timer = window.setInterval(load, 60_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [workspaceId])

  if (!limitWindow) return null
  const remainingPercent = Math.max(0, Math.min(100, 100 - limitWindow.usedPercent))
  const providers: ProviderLimitsData[] = [{
    id: 'codex',
    name: 'ChatGPT',
    company: 'OpenAI',
    ariaLabel: 'Codex usage limits',
    limits: [{
      label: 'Weekly',
      value: resetLabel(limitWindow.resetsAt),
      remainingPercent
    }]
  }]

  return <ProviderLimits providers={providers} className={className} />
})
