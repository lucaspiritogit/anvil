import { create } from 'zustand'

interface Draft {
  prompt: string
  chosen: string[]
}

const emptyDraft: Draft = { prompt: '', chosen: [] }
// Session-only drafts survive composer unmounts without writing prompt text to disk.
const useDrafts = create<{ drafts: Record<string, Draft> }>(() => ({ drafts: {} }))

export function carryTaskComposerPrompt(workspaceId: string, fromProjectId: string | null, toProjectId: string): void {
  const from = JSON.stringify([workspaceId, fromProjectId])
  const to = JSON.stringify([workspaceId, toProjectId])
  useDrafts.setState((state) => {
    const prompt = state.drafts[from]?.prompt
    if (!prompt || state.drafts[to]?.prompt) return state
    return { drafts: { ...state.drafts, [to]: { prompt, chosen: [] } } }
  })
}

export function useTaskComposerDraft(key: string) {
  const draft = useDrafts((state) => state.drafts[key] ?? emptyDraft)
  const update = (patch: Partial<Draft>): void => {
    useDrafts.setState((state) => ({ drafts: {
      ...state.drafts, [key]: { ...(state.drafts[key] ?? emptyDraft), ...patch }
    } }))
  }
  return {
    ...draft,
    setPrompt: (prompt: string) => update({ prompt }),
    setChosen: (chosen: string[]) => update({ chosen }),
    clearSubmitted: () => {
      useDrafts.setState((state) => {
        // Object identity also protects edits that restore the original text.
        if ((state.drafts[key] ?? emptyDraft) !== draft) return state
        const drafts = { ...state.drafts }
        delete drafts[key]
        return { drafts }
      })
    }
  }
}
