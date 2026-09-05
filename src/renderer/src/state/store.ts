import { create } from 'zustand'
import type {
  AgentDefinition,
  ProviderModelList,
  RebaseStep,
  Project,
  ProjectGitStatus,
  Run,
  RunComment,
  RunDiff,
  RunEvent,
  Settings
} from '@shared/types'

const MAX_LINES_IN_MEMORY = 4000

export type CenterView = { kind: 'home' } | { kind: 'terminal' } | { kind: 'run'; runId: string }

interface AnvilState {
  ready: boolean
  projects: Project[]
  runs: Run[]
  agents: AgentDefinition[]
  /** Model catalogues, one per agent, fetched the first time they are needed. */
  modelsByAgent: Record<string, ProviderModelList>
  loadingModelsAgentId: string | null
  settings: Settings | null

  activeProjectId: string | null
  view: CenterView
  eventsByRun: Record<string, RunEvent[]>
  diffsByRun: Record<string, RunDiff>
  diffErrorsByRun: Record<string, string>
  gitStatusByProject: Record<string, ProjectGitStatus>
  commentsByRun: Record<string, RunComment[]>
  rebaseRunId: string | null
  rebasing: string | null
  sendingComments: string | null
  commentError: string | null
  gitInitPending: string | null
  gitInitError: string | null

  newTaskOpen: boolean
  settingsOpen: boolean
  sidebarCollapsed: boolean

  load: () => Promise<void>
  addProject: () => Promise<void>
  removeProject: (id: string) => Promise<void>
  updateProject: (
    id: string,
    patch: Pick<Project, 'monthlyTokenLimit' | 'monthlyCostLimitUsd' | 'finishOnPush'>
  ) => Promise<void>
  selectProject: (id: string) => void
  loadGitStatus: (id: string) => Promise<void>
  initGitRepo: (id: string) => Promise<void>

  approveRun: (runId: string) => Promise<void>
  openRebase: (runId: string | null) => void
  rebaseRun: (runId: string, steps: RebaseStep[]) => Promise<void>
  rebaseWithAgent: (runId: string) => Promise<void>

  loadComments: (runId: string) => Promise<void>
  addComment: (input: {
    runId: string
    file: string
    side: RunComment['side']
    lineNumber: number
    body: string
  }) => Promise<void>
  removeComment: (runId: string, id: string) => Promise<void>
  sendComments: (runId: string) => Promise<void>

  loadAgentModels: (agentId: string) => Promise<void>
  startRun: (input: { agentId: string; prompt: string; model?: string }) => Promise<void>
  cancelRun: (runId: string) => Promise<void>
  openRun: (runId: string) => Promise<void>
  loadRunDiff: (runId: string) => Promise<void>
  showHome: () => void
  showTerminal: () => void

  applyEvent: (event: RunEvent) => void
  applyRunUpdate: (run: Run) => void

  saveSettings: (patch: Partial<Settings>) => Promise<void>
  toggleSidebar: () => void
  setNewTaskOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
}

export const useStore = create<AnvilState>((set, get) => ({
  ready: false,
  projects: [],
  runs: [],
  agents: [],
  modelsByAgent: {},
  loadingModelsAgentId: null,
  settings: null,

  activeProjectId: null,
  view: { kind: 'home' },
  eventsByRun: {},
  diffsByRun: {},
  diffErrorsByRun: {},
  gitStatusByProject: {},
  gitInitPending: null,
  gitInitError: null,
  commentsByRun: {},
  rebaseRunId: null,
  rebasing: null,
  sendingComments: null,
  commentError: null,

  newTaskOpen: false,
  settingsOpen: false,
  sidebarCollapsed: false,

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
    set((s) => {
      const { [id]: _removed, ...gitStatusByProject } = s.gitStatusByProject
      return {
        projects,
        gitStatusByProject,
        runs: s.runs.filter((r) => r.projectId !== id),
        activeProjectId: s.activeProjectId === id ? (projects[0]?.id ?? null) : s.activeProjectId,
        view: { kind: 'home' } as CenterView
      }
    })
  },

  updateProject: async (id, patch) => {
    const project = await window.anvil.projects.update({ id, ...patch })
    if (!project) return
    set((s) => ({ projects: s.projects.map((item) => (item.id === id ? project : item)) }))
  },

  selectProject: (id) => set({ activeProjectId: id, view: { kind: 'home' } }),

  loadGitStatus: async (id) => {
    const status = await window.anvil.projects.gitStatus(id)
    set((s) => ({ gitStatusByProject: { ...s.gitStatusByProject, [id]: status } }))
  },

  initGitRepo: async (id) => {
    set({ gitInitPending: id, gitInitError: null })
    try {
      const status = await window.anvil.projects.gitInit(id)
      set((s) => ({
        gitStatusByProject: { ...s.gitStatusByProject, [id]: status },
        gitInitPending: null
      }))
    } catch (error) {
      set({
        gitInitPending: null,
        gitInitError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  loadAgentModels: async (agentId) => {
    if (get().modelsByAgent[agentId] || get().loadingModelsAgentId === agentId) return
    set({ loadingModelsAgentId: agentId })
    try {
      const list = await window.anvil.agents.models(agentId)
      set((s) => ({ modelsByAgent: { ...s.modelsByAgent, [agentId]: list } }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((s) => ({
        modelsByAgent: { ...s.modelsByAgent, [agentId]: { agentId, models: [], error: message } }
      }))
    } finally {
      set((s) => (s.loadingModelsAgentId === agentId ? { loadingModelsAgentId: null } : s))
    }
  },

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

  approveRun: async (runId) => {
    try {
      const run = await window.anvil.runs.approve(runId)
      set((s) => ({
        runs: s.runs.map((item) => (item.id === run.id ? run : item)),
        commentError: null
      }))
    } catch (error) {
      set({ commentError: error instanceof Error ? error.message : String(error) })
    }
  },

  openRebase: (runId) => set({ rebaseRunId: runId, commentError: null }),

  /** Applies a plan directly; the diff is reloaded because the commits moved. */
  rebaseRun: async (runId, steps) => {
    set({ rebasing: runId, commentError: null })
    try {
      const run = await window.anvil.runs.rebase({ runId, steps })
      set((s) => ({
        runs: s.runs.map((item) => (item.id === run.id ? run : item)),
        diffsByRun: Object.fromEntries(
          Object.entries(s.diffsByRun).filter(([key]) => key !== runId)
        ),
        rebasing: null,
        rebaseRunId: null
      }))
      await get().loadRunDiff(runId)
    } catch (error) {
      set({
        rebasing: null,
        commentError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  rebaseWithAgent: async (runId) => {
    set({ rebasing: runId, rebaseRunId: null, commentError: null })
    try {
      const run = await window.anvil.runs.rebaseWithAgent(runId)
      set((s) => ({
        runs: s.runs.map((item) => (item.id === run.id ? run : item)),
        // The commit list is about to change, so the cached diff is stale.
        diffsByRun: Object.fromEntries(
          Object.entries(s.diffsByRun).filter(([key]) => key !== runId)
        ),
        rebasing: null
      }))
    } catch (error) {
      set({
        rebasing: null,
        commentError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  loadComments: async (runId) => {
    const comments = await window.anvil.comments.list(runId)
    set((s) => ({ commentsByRun: { ...s.commentsByRun, [runId]: comments } }))
  },

  addComment: async (input) => {
    try {
      const comments = await window.anvil.comments.add(input)
      set((s) => ({
        commentsByRun: { ...s.commentsByRun, [input.runId]: comments },
        commentError: null
      }))
    } catch (error) {
      set({ commentError: error instanceof Error ? error.message : String(error) })
    }
  },

  removeComment: async (runId, id) => {
    const comments = await window.anvil.comments.remove({ runId, id })
    set((s) => ({ commentsByRun: { ...s.commentsByRun, [runId]: comments } }))
  },

  sendComments: async (runId) => {
    set({ sendingComments: runId, commentError: null })
    try {
      const { run, comments } = await window.anvil.comments.send(runId)
      set((s) => ({
        runs: s.runs.map((item) => (item.id === run.id ? run : item)),
        commentsByRun: { ...s.commentsByRun, [runId]: comments },
        // The task is running again, so its log is what matters now.
        eventsByRun: { ...s.eventsByRun, [runId]: s.eventsByRun[runId] ?? [] },
        diffsByRun: Object.fromEntries(
          Object.entries(s.diffsByRun).filter(([key]) => key !== runId)
        ),
        sendingComments: null
      }))
    } catch (error) {
      set({
        sendingComments: null,
        commentError: error instanceof Error ? error.message : String(error)
      })
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
    set((s) => ({
      runs: s.runs.map((r) => (r.id === run.id ? run : r)),
      diffsByRun: Object.fromEntries(Object.entries(s.diffsByRun).filter(([id]) => id !== run.id))
    })),

  saveSettings: async (patch) => {
    const settings = await window.anvil.settings.set(patch)
    set({ settings })
  },

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setNewTaskOpen: (open) => set({ newTaskOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open })
}))
