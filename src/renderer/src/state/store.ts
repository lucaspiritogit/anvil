import { create } from 'zustand'
import type { AgentDefinition, Project, Run, RunDiff, RunEvent, Settings } from '@shared/types'

const MAX_LINES_IN_MEMORY = 4000

export type CenterView = { kind: 'home' } | { kind: 'terminal' } | { kind: 'run'; runId: string }

interface AnvilState {
  ready: boolean
  projects: Project[]
  runs: Run[]
  agents: AgentDefinition[]
  settings: Settings | null

  activeProjectId: string | null
  view: CenterView
  eventsByRun: Record<string, RunEvent[]>
  diffsByRun: Record<string, RunDiff>
  diffErrorsByRun: Record<string, string>

  newTaskOpen: boolean
  settingsOpen: boolean

  load: () => Promise<void>
  addProject: () => Promise<void>
  removeProject: (id: string) => Promise<void>
  updateProject: (
    id: string,
    patch: Pick<Project, 'monthlyTokenLimit' | 'monthlyCostLimitUsd' | 'finishOnPush'>
  ) => Promise<void>
  selectProject: (id: string) => void

  startRun: (input: { agentId: string; prompt: string; model?: string }) => Promise<void>
  cancelRun: (runId: string) => Promise<void>
  openRun: (runId: string) => Promise<void>
  loadRunDiff: (runId: string) => Promise<void>
  showHome: () => void
  showTerminal: () => void

  applyEvent: (event: RunEvent) => void
  applyRunUpdate: (run: Run) => void

  saveSettings: (patch: Partial<Settings>) => Promise<void>
  setNewTaskOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
}

export const useStore = create<AnvilState>((set, get) => ({
  ready: false,
  projects: [],
  runs: [],
  agents: [],
  settings: null,

  activeProjectId: null,
  view: { kind: 'home' },
  eventsByRun: {},
  diffsByRun: {},
  diffErrorsByRun: {},

  newTaskOpen: false,
  settingsOpen: false,

  load: async () => {
    const [projects, runs, agents, settings] = await Promise.all([
      window.anvil.projects.list(),
      window.anvil.runs.list(),
      window.anvil.agents.list(),
      window.anvil.settings.get()
    ])
    set({
      projects,
      runs,
      agents,
      settings,
      activeProjectId: get().activeProjectId ?? projects[0]?.id ?? null,
      ready: true
    })
  },

  addProject: async () => {
    const project = await window.anvil.projects.add()
    if (!project) return
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id) ? s.projects : [...s.projects, project],
      activeProjectId: project.id,
      view: { kind: 'home' }
    }))
  },

  removeProject: async (id) => {
    const projects = await window.anvil.projects.remove(id)
    set((s) => ({
      projects,
      runs: s.runs.filter((r) => r.projectId !== id),
      activeProjectId: s.activeProjectId === id ? (projects[0]?.id ?? null) : s.activeProjectId,
      view: { kind: 'home' }
    }))
  },

  updateProject: async (id, patch) => {
    const project = await window.anvil.projects.update({ id, ...patch })
    if (!project) return
    set((s) => ({ projects: s.projects.map((item) => (item.id === id ? project : item)) }))
  },

  selectProject: (id) => set({ activeProjectId: id, view: { kind: 'home' } }),

  startRun: async ({ agentId, prompt, model }) => {
    const projectId = get().activeProjectId
    if (!projectId) return
    const run = await window.anvil.runs.start({ projectId, agentId, prompt, model })
    set((s) => ({
      runs: [run, ...s.runs],
      eventsByRun: { ...s.eventsByRun, [run.id]: [] },
      view: { kind: 'run', runId: run.id },
      newTaskOpen: false
    }))
  },

  cancelRun: async (runId) => {
    await window.anvil.runs.cancel(runId)
  },

  openRun: async (runId) => {
    set({ view: { kind: 'run', runId } })
    if (get().eventsByRun[runId]) return
    const events = await window.anvil.runs.events(runId)
    set((s) => ({ eventsByRun: { ...s.eventsByRun, [runId]: events } }))
  },

  loadRunDiff: async (runId) => {
    if (get().diffsByRun[runId]) return
    try {
      const diff = await window.anvil.runs.diff(runId)
      set((s) => ({
        diffsByRun: { ...s.diffsByRun, [runId]: diff },
        diffErrorsByRun: { ...s.diffErrorsByRun, [runId]: '' }
      }))
    } catch (error) {
      set((s) => ({
        diffErrorsByRun: {
          ...s.diffErrorsByRun,
          [runId]: error instanceof Error ? error.message : String(error)
        }
      }))
    }
  },

  showHome: () => set({ view: { kind: 'home' } }),
  showTerminal: () => set({ view: { kind: 'terminal' } }),

  applyEvent: (event) =>
    set((s) => {
      const existing = s.eventsByRun[event.runId]
      if (!existing) return s
      const next = [...existing, event]
      return {
        eventsByRun: {
          ...s.eventsByRun,
          [event.runId]: next.length > MAX_LINES_IN_MEMORY ? next.slice(-MAX_LINES_IN_MEMORY) : next
        }
      }
    }),

  applyRunUpdate: (run) =>
    set((s) => ({ runs: s.runs.map((r) => (r.id === run.id ? run : r)) })),

  saveSettings: async (patch) => {
    const settings = await window.anvil.settings.set(patch)
    set({ settings })
  },

  setNewTaskOpen: (open) => set({ newTaskOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open })
}))
