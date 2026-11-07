import { memo, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { cachedWorkspaceUsage, subscribeWorkspaceUsage, workspaceUsageProviders, type WorkspaceUsageSnapshot } from '../workspace-usage-limits'
import { ProviderLimits } from './ProviderLimits'

export const WorkspaceUsageLimits = memo(function WorkspaceUsageLimits({ className }: { className?: string }): JSX.Element | null {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const [usage, setUsage] = useState<{ workspaceId: string | null; snapshot: WorkspaceUsageSnapshot | null }>(() => ({
    workspaceId,
    snapshot: workspaceId ? cachedWorkspaceUsage(workspaceId) : null
  }))

  useEffect(() => {
    if (!workspaceId) return
    return subscribeWorkspaceUsage(workspaceId, window.anvil.accounts, (snapshot) => {
      setUsage({ workspaceId, snapshot })
    })
  }, [workspaceId])

  const snapshot = usage.workspaceId === workspaceId ? usage.snapshot : workspaceId ? cachedWorkspaceUsage(workspaceId) : null
  if (!workspaceId || !snapshot) return null
  return <ProviderLimits providers={workspaceUsageProviders(snapshot)} className={className} />
})
