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

export async function importLegacyComposer(): Promise<void> {
  const key = 'anvil-composer-preferences-v2'
  const source = localStorage.getItem(key)
  if (!source) return
  let preferences: ComposerPreferences
  try {
    const saved = JSON.parse(source).state
    const stringRecord = (value: unknown): boolean => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string'))
    if (!saved || typeof saved.agentId !== 'string' || !stringRecord(saved.modelsByAgent) || !stringRecord(saved.reasoningByAgentModel)) return
    preferences = { agentId: saved.agentId, modelsByAgent: saved.modelsByAgent, reasoningByAgentModel: saved.reasoningByAgentModel }
  } catch {
    return
  }
  await window.anvil.workspaces.importComposer(preferences)
  // Preserve a source changed during the import, and all sources on failure.
  if (localStorage.getItem(key) === source) localStorage.removeItem(key)
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
