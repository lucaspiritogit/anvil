import { create } from 'zustand'
import type { Settings, Project } from '@shared/types'
import { useStore } from './store'

type Patch = Partial<Settings> & Partial<Pick<Project, 'monthlyTokenLimit' | 'monthlyCostLimitUsd' | 'finishOnPush'>>
type Edit = { patch: Patch; draft: Record<string, unknown>; status: 'pending' | 'error' | 'saved' }

// Keep accepted edits alive across page dismissal and workspace navigation.
export const useSettingsAutosave = create<{ edits: Record<string, Edit> }>(() => ({ edits: {} }))

export function autosave(key: string, patch: Patch, draft: Record<string, unknown> = patch): void {
  if (Object.keys(patch).length === 0) return
  const previous = useSettingsAutosave.getState().edits[key]
  const edit: Edit = {
    patch: { ...(previous?.status !== 'saved' ? previous?.patch : {}), ...patch },
    draft: { ...(previous?.status !== 'saved' ? previous?.draft : {}), ...draft },
    status: 'pending'
  }
  useSettingsAutosave.setState((state) => ({ edits: { ...state.edits, [key]: edit } }))
  const [kind, ...identity] = key.split(':')
  const id = identity.join(':')
  const request = kind === 'workspace'
    ? useStore.getState().saveSettings(edit.patch, id)
    : useStore.getState().updateProject(identity.slice(1).join(':'), edit.patch, identity[0])
  const finish = (status: Edit['status']): void => {
    useSettingsAutosave.setState((state) => state.edits[key] === edit
      ? { edits: { ...state.edits, [key]: { ...edit, status } } }
      : state)
  }
  void request.then(() => finish('saved'), () => finish('error'))
}

export function retryAutosave(key: string): void {
  const edit = useSettingsAutosave.getState().edits[key]
  if (edit?.status === 'error') autosave(key, edit.patch, edit.draft)
}
