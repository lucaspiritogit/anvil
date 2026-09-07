import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const THINKING_LEVELS = ['Off', 'Low', 'Medium', 'High', 'Extra high'] as const
export type ThinkingLevel = typeof THINKING_LEVELS[number]

interface ComposerPreferences {
  agentId: string
  modelsByAgent: Record<string, string>
  thinkingLevel: ThinkingLevel
  /** OpenCode effort IDs keyed by the full provider/model route. */
  effortsByModel: Record<string, string>
}

interface ComposerPreferencesState extends ComposerPreferences {
  setAgentId: (agentId: string) => void
  setModel: (agentId: string, model: string) => void
  setThinkingLevel: (thinkingLevel: ThinkingLevel) => void
  setModelEffort: (model: string, effort: string) => void
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
    effortsByModel: stringRecord(preferences.effortsByModel),
    thinkingLevel: THINKING_LEVELS.includes(preferences.thinkingLevel as ThinkingLevel)
      ? preferences.thinkingLevel as ThinkingLevel : 'Medium'
  }
}

// Electron keeps localStorage in the app's user-data directory, across renderer restarts.
// Keep selections separate from per-project prompt drafts and legacy agent defaults.
export const useComposerPreferences = create<ComposerPreferencesState>()(persist((set) => ({
  ...restorePreferences(undefined),
  setAgentId: (agentId) => set({ agentId }),
  setModel: (agentId, model) => set((state) => ({ modelsByAgent: { ...state.modelsByAgent, [agentId]: model } })),
  setThinkingLevel: (thinkingLevel) => set({ thinkingLevel }),
  setModelEffort: (model, effort) => set((state) => ({ effortsByModel: { ...state.effortsByModel, [model]: effort } }))
}), {
  name: 'anvil-composer-preferences',
  partialize: ({ agentId, modelsByAgent, thinkingLevel, effortsByModel }) => ({ agentId, modelsByAgent, thinkingLevel, effortsByModel }),
  merge: (saved, current) => ({ ...current, ...restorePreferences(saved) })
}))
