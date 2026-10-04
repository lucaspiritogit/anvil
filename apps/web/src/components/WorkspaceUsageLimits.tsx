import { memo, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { emptyWorkspaceUsage, watchWorkspaceUsage, workspaceUsageProviders, type WorkspaceUsageSnapshot } from '../workspace-usage-limits'
import { ProviderLimits } from './ProviderLimits'

export const WorkspaceUsageLimits = memo(function WorkspaceUsageLimits({ className }: { className?: string }): JSX.Element | null {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const [usage, setUsage] = useState<{ workspaceId: string | null; snapshot: WorkspaceUsageSnapshot }>(() => ({
    workspaceId: null,
    snapshot: emptyWorkspaceUsage()
  }))

  useEffect(() => {
    if (!workspaceId) return
    return watchWorkspaceUsage(workspaceId, window.anvil.accounts, (snapshot) => {
      setUsage({ workspaceId, snapshot })
    })
  }, [workspaceId])

  if (!workspaceId || usage.workspaceId !== workspaceId) return null
  return <ProviderLimits providers={workspaceUsageProviders(usage.snapshot)} className={className} />
})
