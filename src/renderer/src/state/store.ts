import { create } from 'zustand'
import { hydrateComposer, importLegacyComposer } from './composer-preferences'
import { enqueueWorkspaceRequest } from './workspace-requests'
import type { SettingsSectionId } from '../settings-sections'
import type {
  AgentDefinition,
  ProviderModelList,
  RebaseStep,
  Project,
  ProjectGitStatus,
  Task,
  TaskComment,
  TaskImageAttachment,
  TaskDiff,
  TaskEvent,
  TaskMergePreview,
  Settings, Workspace, WorkspaceSnapshot, WorkspaceSettingsChange
} from '@shared/types'

const MAX_LINES_IN_MEMORY = 4000

// A new selection invalidates asynchronous responses from the previous profile.
const modelGenerations = new Map<string, number>()
let workspaceGeneration = 0
type CaffeineSave = { value: boolean; status: 'pending' | 'error' }

export type CenterView = { kind: 'home' } | { kind: 'task'; taskId: string; issueId?: string }

interface AnvilState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  workspaceSwitching: boolean
  workspaceError: string | null
  selectWorkspace: (workspaceId: string) => Promise<void>
  createWorkspace: (name: string) => Promise<void>
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>
  applyWorkspaceSnapshot: (snapshot: WorkspaceSnapshot) => void
  receiveWorkspaceSelection: (snapshot: WorkspaceSnapshot) => void
  applySettingsChange: (change: WorkspaceSettingsChange) => void
  ready: boolean
  projects: Project[]
  tasks: Task[]
  agents: AgentDefinition[]
  /** Model catalogues, one per agent, fetched the first time they are needed. */
  modelsByAgent: Record<string, ProviderModelList>
  modelsByWorkspace: Record<string, Record<string, ProviderModelList>>
  invalidateAgentModels: (workspaceId: string) => void
  loadingModelsAgentId: string | null
  settings: Settings | null
  caffeineSave: CaffeineSave | null
  setCaffeineMode: (value: boolean) => Promise<void>

  activeProjectId: string | null
  view: CenterView
  eventsByTask: Record<string, TaskEvent[]>
  diffsByTask: Record<string, TaskDiff>
  diffErrorsByTask: Record<string, string>
  diffsByIssue: Record<string, TaskDiff>
  diffErrorsByIssue: Record<string, string>
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
  settingsSection: SettingsSectionId
  settingsProjectId: string | null
  setSettingsSection: (section: SettingsSectionId) => void
  setSettingsProject: (id: string) => void
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

  approveTask: (taskId: string, preview: TaskMergePreview) => Promise<void>
  approveIssue: (taskId: string) => Promise<void>
  rejectIssue: (taskId: string, issueId: string, comment?: string) => Promise<void>
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
  startTask: (input: { agentId: string; prompt: string; model?: string; reasoningEffort?: string; images?: TaskImageAttachment[]; fileReferences?: string[] }) => Promise<void>
  steerTask: (taskId: string, message: string) => Promise<void>
  cancelTask: (taskId: string) => Promise<void>
  openTask: (taskId: string, issueId?: string) => Promise<void>
  loadTaskDiff: (taskId: string) => Promise<void>
  loadIssueDiff: (taskId: string, issueId: string) => Promise<void>
  showHome: () => void
  focusTaskComposer: () => void

  applyEvent: (event: TaskEvent) => void
  applyTaskUpdate: (task: Task) => void

  saveSettings: (patch: Partial<Settings>) => Promise<void>
  toggleSidebar: () => void
  setNewTaskOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
}

export const useStore = create<AnvilState>((set, get) => ({
  workspaces: [], activeWorkspaceId: null, workspaceSwitching: false, workspaceError: null,
  receiveWorkspaceSelection: (snapshot) => {
    if (!get().ready || get().workspaceSwitching || get().activeWorkspaceId === snapshot.workspace.id) return
    workspaceGeneration += 1
    get().applyWorkspaceSnapshot(snapshot)
  },
  applyWorkspaceSnapshot: (snapshot) => {
    hydrateComposer(snapshot.workspace.id, snapshot.preferences.composer)
    const changed = get().activeWorkspaceId !== snapshot.workspace.id
    set({
      workspaces: snapshot.workspaces, activeWorkspaceId: snapshot.workspace.id,
      settings: snapshot.settings, projects: snapshot.projects, tasks: snapshot.tasks,
      activeProjectId: snapshot.projects.find((project) => project.id === snapshot.preferences.lastProjectId)?.id ?? snapshot.projects[0]?.id ?? null,
      ready: true,
      ...(changed ? {
        view: { kind: 'home' }, newTaskOpen: false, taskMenu: null, rebaseTaskId: null,
        settingsProjectId: null, settingsSection: 'general', caffeineSave: null,
        modelsByAgent: get().modelsByWorkspace[snapshot.workspace.id] ?? {}, loadingModelsAgentId: null,
        eventsByTask: {}, diffsByTask: {}, diffErrorsByTask: {}, diffsByIssue: {}, diffErrorsByIssue: {},
        commentsByTask: {}, sendingComments: null, commentError: null, rebasing: null,
        gitStatusByProject: {}, gitInitPending: null, gitInitError: null
      } : {})
    })
  },
  applySettingsChange: ({ workspaceId, settings }) => {
    if (get().activeWorkspaceId === workspaceId && !get().workspaceSwitching) set({ settings })
  },
  selectWorkspace: async (workspaceId) => {
    const generation = ++workspaceGeneration
    set({ workspaceSwitching: true, workspaceError: null })
    try {
      await enqueueWorkspaceRequest(async () => {
        const snapshot = await window.anvil.workspaces.select(workspaceId)
        if (generation === workspaceGeneration) get().applyWorkspaceSnapshot(snapshot)
      })
    } catch (error) {
      if (generation !== workspaceGeneration) return
      if (generation === workspaceGeneration) {
        // A prior queued selection may have succeeded. Restore main to the
        // coherent profile still shown by the renderer before enabling input.
        const previous = get().activeWorkspaceId
        try {
          if (previous) {
            const snapshot = await enqueueWorkspaceRequest(() => window.anvil.workspaces.select(previous))
            if (generation === workspaceGeneration) get().applyWorkspaceSnapshot(snapshot)
          }
        } catch {
          if (generation === workspaceGeneration) set({ workspaceError: 'Could not restore the workspace. Retry switching to continue.' })
          return
        }
        if (generation !== workspaceGeneration) return
        set({ workspaceError: error instanceof Error ? error.message : 'Could not switch workspace' })
      }
    }
    if (generation === workspaceGeneration) set({ workspaceSwitching: false })
  },
  createWorkspace: async (name) => {
    const workspace = await window.anvil.workspaces.create(name)
    set({ workspaces: await window.anvil.workspaces.list() })
    await get().selectWorkspace(workspace.id)
  },
  renameWorkspace: async (workspaceId, name) => {
    await window.anvil.workspaces.rename(workspaceId, name)
    set({ workspaces: await window.anvil.workspaces.list() })
  },
  ready: false,
  projects: [],
  tasks: [],
  agents: [],
  modelsByAgent: {},
  modelsByWorkspace: {},
  invalidateAgentModels: (workspaceId) => {
    modelGenerations.set(workspaceId, (modelGenerations.get(workspaceId) ?? 0) + 1)
    set((state) => ({
      modelsByWorkspace: { ...state.modelsByWorkspace, [workspaceId]: {} },
      ...(state.activeWorkspaceId === workspaceId ? { modelsByAgent: {}, loadingModelsAgentId: null } : {})
    }))
  },
  loadingModelsAgentId: null,
  settings: null,
  caffeineSave: null,

  activeProjectId: null,
  view: { kind: 'home' },
  eventsByTask: {},
  diffsByTask: {},
  diffErrorsByTask: {},
  diffsByIssue: {},
  diffErrorsByIssue: {},
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
  settingsSection: 'general',
  settingsProjectId: null,
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setSettingsProject: (settingsProjectId) => set({ settingsProjectId }),
  sidebarCollapsed: false,
  taskMenu: null,
  setTaskMenu: (taskMenu) => set({ taskMenu }),

  load: async () => {
    const generation = ++workspaceGeneration
    try {
      await enqueueWorkspaceRequest(async () => {
        await importLegacyComposer()
        const [snapshot, agents] = await Promise.all([window.anvil.workspaces.snapshot(), window.anvil.agents.list()])
        if (generation !== workspaceGeneration) return
        set({ agents })
        get().applyWorkspaceSnapshot(snapshot)
        set({ workspaceError: null })
      })
    } catch (error) {
      if (generation !== workspaceGeneration) return
      if (generation === workspaceGeneration) set({ workspaceError: error instanceof Error ? error.message : 'Could not load workspace' })
    }
  },

  addProject: async () => {
    const workspaceId = get().activeWorkspaceId
    const generation = workspaceGeneration
    const project = await window.anvil.projects.add()
    if (!project) return
    if (workspaceId) await enqueueWorkspaceRequest(() => window.anvil.workspaces.setPreferences(workspaceId, { lastProjectId: project.id }))
    if (generation !== workspaceGeneration) return
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
      const tasks = s.tasks.filter((task) => task.projectId !== id)
      const view = s.view
      return {
        projects,
        gitStatusByProject,
        tasks,
        activeProjectId: s.activeProjectId === id ? (projects[0]?.id ?? null) : s.activeProjectId,
        view: view.kind === 'task' && !tasks.some((task) => task.id === view.taskId) ? { kind: 'home' } : view
      }
    })
  },

  updateProject: async (id, patch) => {
    const project = await window.anvil.projects.update({ id, ...patch })
    if (!project) return
    set((s) => ({ projects: s.projects.map((item) => (item.id === id ? project : item)) }))
  },

  selectProject: (id) => {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId || get().workspaceSwitching) return
    set({ activeProjectId: id, view: { kind: 'home' } })
    void enqueueWorkspaceRequest(() => window.anvil.workspaces.setPreferences(workspaceId, { lastProjectId: id }))
      .catch((error: unknown) => {
        if (get().activeWorkspaceId === workspaceId) set({ workspaceError: error instanceof Error ? error.message : 'Could not save project selection' })
      })
  },

  loadGitStatus: async (id) => {
    const status = await window.anvil.projects.gitStatus(id)
    set((s) => ({ gitStatusByProject: { ...s.gitStatusByProject, [id]: status } }))
  },

  initGitRepo: async (id) => {
    const generation = workspaceGeneration
    set({ gitInitPending: id, gitInitError: null })
    try {
      const status = await window.anvil.projects.gitInit(id)
      if (generation !== workspaceGeneration) return
      set((s) => ({
        gitStatusByProject: { ...s.gitStatusByProject, [id]: status },
        gitInitPending: null
      }))
    } catch (error) {
      if (generation !== workspaceGeneration) return
      set({
        gitInitPending: null,
        gitInitError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  loadAgentModels: async (agentId) => {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId || get().workspaceSwitching) return
    const modelGeneration = modelGenerations.get(workspaceId) ?? 0
    const generation = workspaceGeneration
    const current = (): boolean => get().activeWorkspaceId === workspaceId && generation === workspaceGeneration && modelGeneration === (modelGenerations.get(workspaceId) ?? 0)
    if (get().modelsByAgent[agentId] || get().loadingModelsAgentId === agentId) return
    set({ loadingModelsAgentId: agentId })
    try {
      const list = await window.anvil.agents.models(agentId, workspaceId)
      if (!current()) return
      set((s) => ({
        modelsByAgent: { ...s.modelsByAgent, [agentId]: list },
        modelsByWorkspace: { ...s.modelsByWorkspace, [workspaceId]: { ...s.modelsByWorkspace[workspaceId], [agentId]: list } }
      }))
    } catch (err) {
      if (!current()) return
      const message = err instanceof Error ? err.message : String(err)
      set((s) => ({
        modelsByAgent: { ...s.modelsByAgent, [agentId]: { agentId, models: [], error: message } }
      }))
    } finally {
      set((s) => (current() && s.loadingModelsAgentId === agentId ? { loadingModelsAgentId: null } : s))
    }
  },

  startTask: async ({ agentId, prompt, model, reasoningEffort, images, fileReferences }) => {
    if (get().workspaceSwitching || !get().ready) throw new Error('Workspace is still loading')
    const generation = workspaceGeneration
    const projectId = get().activeProjectId
    if (!projectId) throw new Error('Choose a project before starting a task')
    const view = get().view
    const newTaskOpen = get().newTaskOpen
    const task = await window.anvil.tasks.start({
      workspaceId: get().activeWorkspaceId ?? undefined,
      projectId, agentId, prompt, model,
      ...(images?.length ? { images } : {}),
      ...(fileReferences?.length ? { fileReferences } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
    })
    if (generation !== workspaceGeneration) return
    set((s) => ({
      tasks: [task, ...s.tasks],
      eventsByTask: { ...s.eventsByTask, [task.id]: [] },
      ...(s.activeProjectId === projectId && s.view === view && s.newTaskOpen === newTaskOpen
        ? { view: { kind: 'task' as const, taskId: task.id }, newTaskOpen: false }
        : {})
    }))
  },

  steerTask: async (taskId, message) => {
    // Task/session selection and inherited settings are authoritative in main.
    // Updates arrive through task:updated, not a potentially stale IPC snapshot.
    await window.anvil.tasks.steer({ taskId, message })
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

  openTask: async (taskId, issueId) => {
    const task = get().tasks.find((item) => item.id === taskId)
    if (!task) return
    set({ activeProjectId: task.projectId, view: { kind: 'task', taskId, ...(issueId ? { issueId } : {}) } })
    if (issueId) return
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

  loadIssueDiff: async (taskId, issueId) => {
    try {
      const diff = await window.anvil.tasks.issueDiff({ taskId, issueId })
      if (!get().tasks.some((task) => task.id === taskId)) return
      set((s) => ({
        diffsByIssue: { ...s.diffsByIssue, [issueId]: diff },
        diffErrorsByIssue: { ...s.diffErrorsByIssue, [issueId]: '' }
      }))
    } catch (error) {
      if (!get().tasks.some((task) => task.id === taskId)) return
      set((s) => ({
        diffErrorsByIssue: {
          ...s.diffErrorsByIssue,
          [issueId]: error instanceof Error ? error.message : String(error)
        }
      }))
    }
  },

  approveIssue: async (taskId) => {
    const task = await window.anvil.tasks.approveIssue(taskId)
    if (!get().tasks.some((item) => item.id === taskId)) return
    set((s) => ({ tasks: s.tasks.map((item) => (item.id === task.id ? task : item)) }))
  },

  /** A rework request carries an optional general note plus any pending line comments. */
  rejectIssue: async (taskId, issueId, comment) => {
    const body = comment?.trim()
    const task = await window.anvil.tasks.rejectIssue({ taskId, ...(body ? { comment: body } : {}) })
    if (!get().tasks.some((item) => item.id === taskId)) return
    set((s) => ({
      tasks: s.tasks.map((item) => (item.id === task.id ? task : item)),
      // The issue restarts, so its recorded diff range is stale until the next review.
      diffsByIssue: Object.fromEntries(Object.entries(s.diffsByIssue).filter(([key]) => key !== issueId)),
      diffErrorsByIssue: Object.fromEntries(Object.entries(s.diffErrorsByIssue).filter(([key]) => key !== issueId))
    }))
    await get().loadComments(taskId)
  },

  approveTask: async (taskId, preview) => {
    const task = await window.anvil.tasks.approve({ taskId, preview })
    set((s) => ({
      tasks: s.tasks.map((item) => (item.id === task.id ? task : item)),
      commentError: null
    }))
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
    const workspaceId = get().activeWorkspaceId
    const generation = workspaceGeneration
    if (!workspaceId) throw new Error('Workspace is still loading')
    await enqueueWorkspaceRequest(async () => {
      const settings = await window.anvil.settings.set(workspaceId, patch)
      if (get().activeWorkspaceId === workspaceId && generation === workspaceGeneration) set({ settings })
    })
  },

  setCaffeineMode: async (value) => {
    const request: CaffeineSave = { value, status: 'pending' }
    set({ caffeineSave: request })
    try {
      await get().saveSettings({ caffeineMode: value })
      if (get().caffeineSave === request) set({ caffeineSave: null })
    } catch {
      // Only the latest choice controls feedback. Confirmed settings still
      // reflect successful earlier writes if the latest request fails.
      if (get().caffeineSave === request) {
        set({ caffeineSave: { value, status: 'error' } })
      }
    }
  },

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setNewTaskOpen: (open) => set({ newTaskOpen: open }),
  setSettingsOpen: (open) => set((state) => {
    if (state.settingsOpen === open) return state
    return open
      ? { settingsOpen: true, settingsSection: 'general', settingsProjectId: state.activeProjectId }
      : { settingsOpen: false }
  })
}))
