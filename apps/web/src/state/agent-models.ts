import { useEffect } from 'react'
import type { ProviderModelList } from '@anvil/protocol/types'
import { useStore } from './store'

export function useAgentModels(agentId: string): ProviderModelList | undefined {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const switching = useStore((state) => state.workspaceSwitching)
  // Subscribe to the map so invalidating an in-flight catalogue also retries.
  const modelsByAgent = useStore((state) => state.modelsByAgent)
  const loadAgentModels = useStore((state) => state.loadAgentModels)

  useEffect(() => {
    if (workspaceId && !switching && agentId && !modelsByAgent[agentId]) {
      void loadAgentModels(agentId)
    }
  }, [workspaceId, switching, agentId, modelsByAgent, loadAgentModels])

  return modelsByAgent[agentId]
}
