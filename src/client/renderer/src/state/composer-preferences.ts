import { create } from 'zustand'
import type { ComposerPreferences } from '@shared/types'
import { enqueueWorkspaceRequest } from './workspace-requests'

interface ComposerPreferencesState extends ComposerPreferences {
  workspaceId: string | null
  saveError: string | null
  setSelection: (agentId: string, model: string) => void
  setAgentId: (agentId: string) => void
  setModel: (agentId: string, model: string) => void
  setReasoningEffort: (agentId: string, model: string, effort: string) => void
}

export function hydrateComposer(workspaceId: string, preferences: ComposerPreferences): void {
  useComposerPreferences.setState({ workspaceId, ...preferences, saveError: null })
}

export const useComposerPreferences = create<ComposerPreferencesState>((set, get) => {
  const save = (patch: Partial<ComposerPreferences>): void => {
    const workspaceId = get().workspaceId
    if (!workspaceId) return
    set({ ...patch, saveError: null })
    const { agentId, modelsByAgent, reasoningByAgentModel } = get()
    void enqueueWorkspaceRequest(() => window.anvil.workspaces.setPreferences(workspaceId, {
      composer: { agentId, modelsByAgent, reasoningByAgentModel }
    })).catch((error: unknown) => {
      if (get().workspaceId === workspaceId) set({ saveError: error instanceof Error ? error.message : 'Could not save composer preferences' })
    })
  }
  return {
    workspaceId: null, agentId: '', modelsByAgent: {}, reasoningByAgentModel: {}, saveError: null,
    setSelection: (agentId, model) => save({ agentId, modelsByAgent: { ...get().modelsByAgent, [agentId]: model } }),
    setAgentId: (agentId) => save({ agentId }),
    setModel: (agentId, model) => save({ modelsByAgent: { ...get().modelsByAgent, [agentId]: model } }),
    setReasoningEffort: (agentId, model, effort) => save({ reasoningByAgentModel: { ...get().reasoningByAgentModel, [JSON.stringify([agentId, model])]: effort } })
  }
})
