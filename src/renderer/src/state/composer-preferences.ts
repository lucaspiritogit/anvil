import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ComposerPreferences {
  agentId: string
  modelsByAgent: Record<string, string>
  reasoningByAgentModel: Record<string, string>
}

interface ComposerPreferencesState extends ComposerPreferences {
  setAgentId: (agentId: string) => void
  setModel: (agentId: string, model: string) => void
  setReasoningEffort: (agentId: string, model: string, effort: string) => void
}

function stringRecord(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === 'string')) : {}
}

function restorePreferences(saved: unknown): ComposerPreferences {
  const preferences = saved && typeof saved === 'object' ? saved as Partial<ComposerPreferences> : {}
  return {
    agentId: typeof preferences.agentId === 'string' ? preferences.agentId : '',
    modelsByAgent: stringRecord(preferences.modelsByAgent),
    reasoningByAgentModel: stringRecord(preferences.reasoningByAgentModel)
  }
}

// Electron keeps localStorage in the app's user-data directory, across renderer restarts.
// Keep selections separate from per-project prompt drafts and legacy agent defaults.
export const useComposerPreferences = create<ComposerPreferencesState>()(persist((set) => ({
  ...restorePreferences(undefined),
  setAgentId: (agentId) => set({ agentId }),
  setModel: (agentId, model) => set((state) => ({ modelsByAgent: { ...state.modelsByAgent, [agentId]: model } })),
  setReasoningEffort: (agentId, model, effort) => set((state) => ({ reasoningByAgentModel: { ...state.reasoningByAgentModel, [JSON.stringify([agentId, model])]: effort } }))
}), {
  name: 'anvil-composer-preferences-v2',
  partialize: ({ agentId, modelsByAgent, reasoningByAgentModel }) => ({ agentId, modelsByAgent, reasoningByAgentModel }),
  merge: (saved, current) => ({ ...current, ...restorePreferences(saved) })
}))
