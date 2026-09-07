import { create } from 'zustand'
import type {
  AgentDefinition,
  ProviderModelList,
  RebaseStep,
  Project,
  ProjectGitStatus,
  Task,
  TaskComment,
  TaskDiff,
  TaskEvent,
  Settings,
  ThinkingLevel
} from '@shared/types'

const MAX_LINES_IN_MEMORY = 4000

export type CenterView = { kind: 'home' } | { kind: 'terminal' } | { kind: 'task'; taskId: string }

interface AnvilState {
  ready: boolean
  projects: Project[]
  tasks: Task[]
  agents: AgentDefinition[]
  /** Model catalogues, one per agent, fetched the first time they are needed. */
  modelsByAgent: Record<string, ProviderModelList>
  loadingModelsAgentId: string | null
  settings: Settings | null

  activeProjectId: string | null
  view: CenterView
  eventsByTask: Record<string, TaskEvent[]>
  diffsByTask: Record<string, TaskDiff>
  diffErrorsByTask: Record<string, string>
  gitStatusByProject: Record<string, ProjectGitStatus>
  commentsByTask: Record<string, TaskComment[]>
  rebaseTaskId: string | null
  rebasing: string | null
  sendingComments: string | null
  commentError: string | null
  gitInitPending: string | null
  gitInitError: string | null

  newTaskOpen: boolean
  taskComposerFocusRequest: number
  settingsOpen: boolean
  sidebarCollapsed: boolean
  taskMenu: { taskId: string; x: number; y: number } | null
  setTaskMenu: (menu: AnvilState['taskMenu']) => void
  deleteTask: (taskId: string) => Promise<void>
  settleTask: (taskId: string) => Promise<void>

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

  approveTask: (taskId: string) => Promise<void>
  openRebase: (taskId: string | null) => void
  rebaseTask: (taskId: string, steps: RebaseStep[]) => Promise<void>
  rebaseWithAgent: (taskId: string) => Promise<void>

  loadComments: (taskId: string) => Promise<void>
  addComment: (input: {
    taskId: string
    file: string
    side: TaskComment['side']
    lineNumber: number
    body: string
  }) => Promise<void>
  removeComment: (taskId: string, id: string) => Promise<void>
  sendComments: (taskId: string) => Promise<void>

  loadAgentModels: (agentId: string) => Promise<void>
  startTask: (input: { agentId: string; prompt: string; model?: string; thinkingLevel?: ThinkingLevel; modelEffort?: string }) => Promise<void>
  cancelTask: (taskId: string) => Promise<void>
  openTask: (taskId: string) => Promise<void>
  loadTaskDiff: (taskId: string) => Promise<void>
  showHome: () => void
  showTerminal: () => void
  focusTaskComposer: () => void

  applyEvent: (event: TaskEvent) => void
  applyTaskUpdate: (task: Task) => void

  saveSettings: (patch: Partial<Settings>) => Promise<void>
  toggleSidebar: () => void
  setNewTaskOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
}

export const useStore = create<AnvilState>((set, get) => ({
  ready: false,
  projects: [],
  tasks: [],
  agents: [],
  modelsByAgent: {},
  loadingModelsAgentId: null,
  settings: null,

  activeProjectId: null,
  view: { kind: 'home' },
  eventsByTask: {},
  diffsByTask: {},
  diffErrorsByTask: {},
  gitStatusByProject: {},
  gitInitPending: null,
  gitInitError: null,
  commentsByTask: {},
  rebaseTaskId: null,
  rebasing: null,
  sendingComments: null,
  commentError: null,

  newTaskOpen: false,
  taskComposerFocusRequest: 0,
  settingsOpen: false,
  sidebarCollapsed: false,
  taskMenu: null,
  setTaskMenu: (taskMenu) => set({ taskMenu }),

  load: async () => {
    const [projects, tasks, agents, settings] = await Promise.all([
      window.anvil.projects.list(),
      window.anvil.tasks.list(),
      window.anvil.agents.list(),
      window.anvil.settings.get()
    ])
    set({
      projects,
      tasks,
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
        tasks: s.tasks.filter((r) => r.projectId !== id),
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

  startTask: async ({ agentId, prompt, model, thinkingLevel, modelEffort }) => {
    const projectId = get().activeProjectId
    if (!projectId) return
    const task = await window.anvil.tasks.start({
      projectId, agentId, prompt, model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(modelEffort ? { modelEffort } : {})
    })
    set((s) => ({
      tasks: [task, ...s.tasks],
      eventsByTask: { ...s.eventsByTask, [task.id]: [] },
      view: { kind: 'task', taskId: task.id },
      newTaskOpen: false
    }))
  },

  cancelTask: async (taskId) => {
    await window.anvil.tasks.cancel(taskId)
  },

  settleTask: async (taskId) => {
    const task = await window.anvil.tasks.settle(taskId)
    get().applyTaskUpdate(task)
  },

  deleteTask: async (taskId) => {
    await window.anvil.tasks.delete(taskId)
    set((state) => {
      const withoutTask = <Value,>(cache: Record<string, Value>): Record<string, Value> =>
        Object.fromEntries(Object.entries(cache).filter(([id]) => id !== taskId))
      return {
        tasks: state.tasks.filter((task) => task.id !== taskId),
        eventsByTask: withoutTask(state.eventsByTask),
        diffsByTask: withoutTask(state.diffsByTask),
        diffErrorsByTask: withoutTask(state.diffErrorsByTask),
        commentsByTask: withoutTask(state.commentsByTask),
        view: state.view.kind === 'task' && state.view.taskId === taskId
          ? { kind: 'home' as const } : state.view,
        taskMenu: state.taskMenu?.taskId === taskId ? null : state.taskMenu,
        rebaseTaskId: state.rebaseTaskId === taskId ? null : state.rebaseTaskId,
        rebasing: state.rebasing === taskId ? null : state.rebasing,
        sendingComments: state.sendingComments === taskId ? null : state.sendingComments
      }
    })
  },

  openTask: async (taskId) => {
    const task = get().tasks.find((item) => item.id === taskId)
    if (!task) return
    set({ activeProjectId: task.projectId, view: { kind: 'task', taskId } })
    if (get().eventsByTask[taskId]) return
    const events = await window.anvil.tasks.events(taskId)
    if (!get().tasks.some((task) => task.id === taskId)) return
    set((s) => ({ eventsByTask: { ...s.eventsByTask, [taskId]: events } }))
  },

  loadTaskDiff: async (taskId) => {
    if (get().diffsByTask[taskId]) return
    try {
      const diff = await window.anvil.tasks.diff(taskId)
      if (!get().tasks.some((task) => task.id === taskId)) return
      set((s) => ({
        diffsByTask: { ...s.diffsByTask, [taskId]: diff },
        diffErrorsByTask: { ...s.diffErrorsByTask, [taskId]: '' }
      }))
    } catch (error) {
      if (!get().tasks.some((task) => task.id === taskId)) return
      set((s) => ({
        diffErrorsByTask: {
          ...s.diffErrorsByTask,
          [taskId]: error instanceof Error ? error.message : String(error)
        }
      }))
    }
  },

  approveTask: async (taskId) => {
    try {
      const task = await window.anvil.tasks.approve(taskId)
      set((s) => ({
        tasks: s.tasks.map((item) => (item.id === task.id ? task : item)),
        commentError: null
      }))
    } catch (error) {
      set({ commentError: error instanceof Error ? error.message : String(error) })
    }
  },

  openRebase: (taskId) => set({ rebaseTaskId: taskId, commentError: null }),

  /** Applies a plan directly; the diff is reloaded because the commits moved. */
  rebaseTask: async (taskId, steps) => {
    set({ rebasing: taskId, commentError: null })
    try {
      const task = await window.anvil.tasks.rebase({ taskId, steps })
      set((s) => ({
        tasks: s.tasks.map((item) => (item.id === task.id ? task : item)),
        diffsByTask: Object.fromEntries(
          Object.entries(s.diffsByTask).filter(([key]) => key !== taskId)
        ),
        rebasing: null,
        rebaseTaskId: null
      }))
      await get().loadTaskDiff(taskId)
    } catch (error) {
      set({
        rebasing: null,
        commentError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  rebaseWithAgent: async (taskId) => {
    set({ rebasing: taskId, rebaseTaskId: null, commentError: null })
    try {
      const task = await window.anvil.tasks.rebaseWithAgent(taskId)
      set((s) => ({
        tasks: s.tasks.map((item) => (item.id === task.id ? task : item)),
        // The commit list is about to change, so the cached diff is stale.
        diffsByTask: Object.fromEntries(
          Object.entries(s.diffsByTask).filter(([key]) => key !== taskId)
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

  loadComments: async (taskId) => {
    const comments = await window.anvil.comments.list(taskId)
    if (!get().tasks.some((task) => task.id === taskId)) return
    set((s) => ({ commentsByTask: { ...s.commentsByTask, [taskId]: comments } }))
  },

  addComment: async (input) => {
    try {
      const comments = await window.anvil.comments.add(input)
      if (!get().tasks.some((task) => task.id === input.taskId)) return
      set((s) => ({
        commentsByTask: { ...s.commentsByTask, [input.taskId]: comments },
        commentError: null
      }))
    } catch (error) {
      set({ commentError: error instanceof Error ? error.message : String(error) })
    }
  },

  removeComment: async (taskId, id) => {
    const comments = await window.anvil.comments.remove({ taskId, id })
    if (!get().tasks.some((task) => task.id === taskId)) return
    set((s) => ({ commentsByTask: { ...s.commentsByTask, [taskId]: comments } }))
  },

  sendComments: async (taskId) => {
    set({ sendingComments: taskId, commentError: null })
    try {
      const { task, comments } = await window.anvil.comments.send(taskId)
      if (!get().tasks.some((item) => item.id === taskId)) return
      set((s) => ({
        tasks: s.tasks.map((item) => (item.id === task.id ? task : item)),
        commentsByTask: { ...s.commentsByTask, [taskId]: comments },
        // The task is running again, so its log is what matters now.
        eventsByTask: { ...s.eventsByTask, [taskId]: s.eventsByTask[taskId] ?? [] },
        diffsByTask: Object.fromEntries(
          Object.entries(s.diffsByTask).filter(([key]) => key !== taskId)
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
  focusTaskComposer: () => set((state) => {
    if (!state.activeProjectId || state.newTaskOpen || state.settingsOpen || state.taskMenu || state.rebaseTaskId) return state
    return {
      view: { kind: 'home' },
      taskComposerFocusRequest: state.taskComposerFocusRequest + 1
    }
  }),

  applyEvent: (event) =>
    set((s) => {
      const existing = s.eventsByTask[event.taskId]
      if (!existing) return s
      const eventIndex = existing.findIndex((entry) => entry.id === event.id)
      const next = eventIndex === -1 ? [...existing, event] : existing.map((entry, index) => index === eventIndex ? event : entry)
      return {
        eventsByTask: {
          ...s.eventsByTask,
          [event.taskId]: next.length > MAX_LINES_IN_MEMORY ? next.slice(-MAX_LINES_IN_MEMORY) : next
        }
      }
    }),

  applyTaskUpdate: (task) =>
    set((s) => ({
      tasks: s.tasks.map((r) => (r.id === task.id ? task : r)),
      diffsByTask: Object.fromEntries(Object.entries(s.diffsByTask).filter(([id]) => id !== task.id))
    })),

  saveSettings: async (patch) => {
    const settings = await window.anvil.settings.set(patch)
    set({ settings })
  },

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setNewTaskOpen: (open) => set({ newTaskOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open })
}))
