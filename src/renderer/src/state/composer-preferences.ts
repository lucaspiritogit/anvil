import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const THINKING_LEVELS = ['Off', 'Low', 'Medium', 'High', 'Extra high'] as const
export type ThinkingLevel = typeof THINKING_LEVELS[number]

interface ComposerPreferences {
  agentId: string
  modelsByAgent: Record<string, string>
  thinkingLevel: ThinkingLevel
}

interface ComposerPreferencesState extends ComposerPreferences {
  setAgentId: (agentId: string) => void
  setModel: (agentId: string, model: string) => void
  setThinkingLevel: (thinkingLevel: ThinkingLevel) => void
}

function restorePreferences(saved: unknown): ComposerPreferences {
  const preferences = saved && typeof saved === 'object' ? saved as Partial<ComposerPreferences> : {}
  return {
    agentId: typeof preferences.agentId === 'string' ? preferences.agentId : '',
    modelsByAgent: preferences.modelsByAgent && typeof preferences.modelsByAgent === 'object'
      ? Object.fromEntries(Object.entries(preferences.modelsByAgent).filter(([, model]) => typeof model === 'string'))
      : {},
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
  setThinkingLevel: (thinkingLevel) => set({ thinkingLevel })
}), {
  name: 'anvil-composer-preferences',
  partialize: ({ agentId, modelsByAgent, thinkingLevel }) => ({ agentId, modelsByAgent, thinkingLevel }),
  merge: (saved, current) => ({ ...current, ...restorePreferences(saved) })
}))
