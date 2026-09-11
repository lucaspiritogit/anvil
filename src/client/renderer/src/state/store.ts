import { create } from 'zustand'
import { DEFAULT_TASK_EVENT_PAGE_SIZE, MAX_TASK_EVENT_PAGE_SIZE } from '../../../../shared/types'
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
  TaskEventCursor,
  TaskEventsRequest,
  TaskMergePreview,
  Settings, Workspace, WorkspaceSnapshot, WorkspaceSettingsChange
} from '@shared/types'

const MAX_LINES_IN_MEMORY = MAX_TASK_EVENT_PAGE_SIZE

type HistoryDirection = 'initial' | 'older' | 'newer' | 'latest'
export interface TaskEventHistory {
  taskId: string
  oldestCursor: TaskEventCursor | null
  newestCursor: TaskEventCursor | null
  hasOlder: boolean
  hasNewer: boolean
  followingLatest: boolean
  loaded: boolean
  loading: HistoryDirection | null
  error: string | null
}
let taskViewGeneration = 0
interface HistoryRequest {
  promise: Promise<void>
  live: Map<string, TaskEvent>
  direction: HistoryDirection
  before?: number
  after?: number
  newestLiveSequence: number
}
let historyRequest: HistoryRequest | null = null
const evictTaskEvents = () => {
  taskViewGeneration += 1
  historyRequest?.live.clear()
  historyRequest = null
  return { eventsByTask: {}, taskEventHistory: null }
}
const emptyHistory = (taskId: string): TaskEventHistory => ({
  taskId, oldestCursor: null, newestCursor: null, hasOlder: false, hasNewer: false,
  followingLatest: true, loaded: false, loading: null, error: null
})
const mergeEvents = (...groups: TaskEvent[][]): TaskEvent[] => {
  const events = new Map<string, TaskEvent>()
  for (const group of groups) for (const event of group) events.set(event.id, event)
  return [...events.values()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
}
const eventCursor = (event: TaskEvent | undefined): TaskEventCursor | null =>
  event?.sequence === undefined ? null : { taskId: event.taskId, sequence: event.sequence }

// A new selection invalidates asynchronous responses from the previous profile.
const modelGenerations = new Map<string, number>()
let workspaceGeneration = 0
const taskDiffRequests = new Map<string, { view: CenterView; revision: string; generation: number }>()
const taskDiffRevision = (task?: Task): string => JSON.stringify(task ? [
  task.workspaceId, task.status, task.deliveryStatus, task.branchName, task.baseCommit, task.headCommit,
  task.filesChanged, task.additions, task.deletions
] : null)
type CaffeineSave = { value: boolean; status: 'pending' | 'error' }

export type CenterView = { kind: 'home' } | { kind: 'task'; taskId: string }

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
  taskEventHistory: TaskEventHistory | null
  loadTaskEvents: (taskId: string, direction?: HistoryDirection) => Promise<void>
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
    patch: Partial<Pick<Project, 'monthlyTokenLimit' | 'monthlyCostLimitUsd' | 'finishOnPush'>>,
    workspaceId?: string
  ) => Promise<void>
  selectProject: (id: string) => void
  loadGitStatus: (id: string) => Promise<void>
  initGitRepo: (id: string) => Promise<void>

  approveTask: (taskId: string, preview: TaskMergePreview) => Promise<void>
  approveIssue: (taskId: string, issueId: string, headCommit: string | null) => Promise<void>
  rejectIssue: (taskId: string, issueId: string, comment?: string, headCommit?: string | null) => Promise<void>
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
  startTask: (input: { parentTaskId?: string; agentId: string; prompt: string; model?: string; reasoningEffort?: string; images?: TaskImageAttachment[]; fileReferences?: string[] }) => Promise<void>
  steerTask: (taskId: string, message: string) => Promise<void>
  cancelTask: (taskId: string) => Promise<void>
  openTask: (taskId: string) => Promise<void>
  loadTaskDiff: (taskId: string) => Promise<void>
  loadIssueDiff: (taskId: string, issueId: string) => Promise<void>
  showHome: () => void
  focusTaskComposer: () => void

  applyEvent: (event: TaskEvent) => void
  applyTaskUpdate: (task: Task) => void

  saveSettings: (patch: Partial<Settings>, workspaceId?: string) => Promise<void>
  toggleSidebar: () => void
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
    const view = get().view
    const removed = view.kind === 'task' && !snapshot.tasks.some((task) => task.id === view.taskId)
    set({
      workspaces: snapshot.workspaces, activeWorkspaceId: snapshot.workspace.id,
      settings: snapshot.settings, projects: snapshot.projects, tasks: snapshot.tasks,
      activeProjectId: snapshot.projects.find((project) => project.id === snapshot.preferences.lastProjectId)?.id ?? snapshot.projects[0]?.id ?? null,
      ready: true,
      ...(changed || removed ? { ...evictTaskEvents(), view: { kind: 'home' as const } } : {}),
      ...(changed ? {
        view: { kind: 'home' }, taskMenu: null, rebaseTaskId: null,
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
    set({ ...evictTaskEvents(), view: { kind: 'home' }, workspaceSwitching: true, workspaceError: null })
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
    if (get().activeWorkspaceId !== workspace.id || get().workspaceError) {
      throw new Error('Workspace created, but it could not be selected. Close this dialog and select it from the Workspace menu to finish setup.')
    }
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
  taskEventHistory: null,
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
    set(evictTaskEvents())
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
      ...evictTaskEvents(),
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
        ...(view.kind === 'task' && !tasks.some((task) => task.id === view.taskId) ? evictTaskEvents() : {}),
        projects,
        gitStatusByProject,
        tasks,
        activeProjectId: s.activeProjectId === id ? (projects[0]?.id ?? null) : s.activeProjectId,
        view: view.kind === 'task' && !tasks.some((task) => task.id === view.taskId) ? { kind: 'home' } : view
      }
    })
  },

  updateProject: async (id, patch, destinationId) => {
    const workspaceId = destinationId ?? get().activeWorkspaceId
    if (!workspaceId) throw new Error('Workspace is still loading')
    await enqueueWorkspaceRequest(async () => {
      const project = await window.anvil.projects.update({ id, ...patch, workspaceId })
      if (!project) throw new Error('Project is unavailable')
      if (get().activeWorkspaceId !== workspaceId) return
      set((s) => ({ projects: s.projects.map((item) => (item.id === id ? project : item)) }))
    })
  },

  selectProject: (id) => {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId || get().workspaceSwitching) return
    set({ ...evictTaskEvents(), activeProjectId: id, view: { kind: 'home' } })
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

  startTask: async ({ parentTaskId, agentId, prompt, model, reasoningEffort, images, fileReferences }) => {
    if (get().workspaceSwitching || !get().ready) throw new Error('Workspace is still loading')
    const generation = workspaceGeneration
    const projectId = get().activeProjectId
    if (!projectId) throw new Error('Choose a project before starting a task')
    const view = get().view
    const task = await window.anvil.tasks.start({
      workspaceId: get().activeWorkspaceId ?? undefined,
      projectId, parentTaskId, agentId, prompt, model,
      ...(images?.length ? { images } : {}),
      ...(fileReferences?.length ? { fileReferences } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
    })
    if (generation !== workspaceGeneration) return
    set((s) => ({
      tasks: [task, ...s.tasks],
      ...(s.activeProjectId === projectId && s.view === view
        ? { ...evictTaskEvents(), view: { kind: 'task' as const, taskId: task.id } }
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
    taskDiffRequests.delete(taskId)
    set((state) => {
      const withoutTask = <Value,>(cache: Record<string, Value>): Record<string, Value> =>
        Object.fromEntries(Object.entries(cache).filter(([id]) => id !== taskId))
      return {
        tasks: state.tasks.filter((task) => task.id !== taskId),
        ...(state.view.kind === 'task' && state.view.taskId === taskId ? evictTaskEvents() : {}),
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
    if (!task) {
      get().showHome()
      return
    }
    const currentView = get().view
    if (currentView.kind !== 'task' || currentView.taskId !== taskId) {
      set({ ...evictTaskEvents(), activeProjectId: task.projectId, view: { kind: 'task', taskId } })
    }
    await get().loadTaskEvents(taskId)
  },

  loadTaskEvents: (taskId, direction = 'initial') => {
    const state = get()
    if (state.workspaceSwitching || state.view.kind !== 'task' || state.view.taskId !== taskId ||
      !state.tasks.some((task) => task.id === taskId)) return Promise.resolve()
    if (historyRequest) return historyRequest.promise
    const history = state.taskEventHistory ?? emptyHistory(taskId)
    if (direction === 'initial' && history.loaded) return Promise.resolve()
    if (direction === 'older' && (!history.hasOlder || !history.oldestCursor)) return Promise.resolve()
    if (direction === 'newer' && (!history.hasNewer || !history.newestCursor)) return Promise.resolve()
    const workspace = workspaceGeneration
    const workspaceId = state.activeWorkspaceId
    const view = taskViewGeneration
    const request: HistoryRequest = {
      promise: Promise.resolve(), live: new Map(), direction, newestLiveSequence: 0,
      before: direction === 'older' ? history.oldestCursor!.sequence : undefined,
      after: direction === 'newer' ? history.newestCursor!.sequence : undefined
    }
    historyRequest = request
    const current = (): boolean => {
      const state = get()
      return historyRequest === request && workspace === workspaceGeneration &&
        workspaceId === state.activeWorkspaceId && view === taskViewGeneration &&
        state.view.kind === 'task' && state.view.taskId === taskId &&
        state.tasks.some((task) => task.id === taskId)
    }
    const input: TaskEventsRequest = {
      taskId, limit: DEFAULT_TASK_EVENT_PAGE_SIZE,
      ...(direction === 'older' ? { before: history.oldestCursor! } : {}),
      ...(direction === 'newer' ? { after: history.newestCursor! } : {})
    }
    set({
      eventsByTask: { [taskId]: state.eventsByTask[taskId] ?? [] },
      taskEventHistory: { ...history, loading: direction, error: null,
        followingLatest: direction === 'older' ? false : history.followingLatest }
    })
    // Defer invocation so duplicate callers always see the same request promise.
    request.promise = Promise.resolve().then(async () => {
      try {
        if (!current()) return
        const page = await window.anvil.tasks.eventsPage(input)
        if (!current()) return
        const state = get()
        const retained = state.eventsByTask[taskId] ?? []
        const live = [...request.live.values()]
        const replacing = direction === 'initial' || direction === 'latest'
        const fetched = mergeEvents(page.events, live.filter((event) =>
          page.events.some((row) => row.id === event.id) ||
          ((replacing || (direction === 'newer' && !page.hasNewer)) &&
            event.sequence! > (page.newestCursor?.sequence ?? input.after?.sequence ?? 0))))
        const merged = replacing ? fetched : mergeEvents(fetched, retained)
        const events = direction === 'older' ? merged.slice(0, MAX_LINES_IN_MEMORY) : merged.slice(-MAX_LINES_IN_MEMORY)
        const trimmed = merged.length > events.length
        const hasOlder = direction === 'older' ? page.hasOlder :
          replacing ? page.hasOlder || trimmed : history.hasOlder || trimmed
        const hasNewer = direction === 'older' ? history.hasNewer || trimmed || state.taskEventHistory!.hasNewer :
          page.hasNewer || request.newestLiveSequence > (events.at(-1)?.sequence ?? 0)
        set({ eventsByTask: { [taskId]: events }, taskEventHistory: {
          taskId, oldestCursor: eventCursor(events[0]), newestCursor: eventCursor(events.at(-1)),
          hasOlder, hasNewer, followingLatest: direction !== 'older' && !hasNewer,
          loaded: true, loading: null, error: null
        } })
      } catch (error) {
        if (!current()) return
        set({ taskEventHistory: { ...get().taskEventHistory!, loading: null,
          error: error instanceof Error ? error.message : String(error) } })
      } finally {
        if (historyRequest === request) historyRequest = null
      }
    })
    return request.promise
  },

  loadTaskDiff: async (taskId) => {
    if (get().diffsByTask[taskId]) return
    const task = get().tasks.find((task) => task.id === taskId)
    if (!task || !['reviewable', 'approved'].includes(task.deliveryStatus)) return
    const revision = taskDiffRevision(task)
    const view = get().view
    const generation = workspaceGeneration
    const pending = taskDiffRequests.get(taskId)
    if (pending?.view === view && pending.revision === revision && pending.generation === generation) return
    const request = { view, revision, generation }
    taskDiffRequests.set(taskId, request)
    set((s) => ({ diffErrorsByTask: { ...s.diffErrorsByTask, [taskId]: '' } }))
    const current = (): boolean => taskDiffRequests.get(taskId) === request &&
      generation === workspaceGeneration && get().view === view &&
      revision === taskDiffRevision(get().tasks.find((task) => task.id === taskId))
    try {
      const diff = await window.anvil.tasks.diff(taskId)
      if (!current()) return
      set((s) => ({
        diffsByTask: { ...s.diffsByTask, [taskId]: diff },
        diffErrorsByTask: { ...s.diffErrorsByTask, [taskId]: '' }
      }))
    } catch (error) {
      if (!current()) return
      set((s) => ({
        diffErrorsByTask: {
          ...s.diffErrorsByTask,
          [taskId]: error instanceof Error ? error.message : String(error)
        }
      }))
    } finally {
      if (taskDiffRequests.get(taskId) === request) taskDiffRequests.delete(taskId)
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

  approveIssue: async (taskId, issueId, headCommit) => {
    const task = await window.anvil.tasks.approveIssue({ taskId, issueId, headCommit })
    await get().loadComments(taskId)
    if (!get().tasks.some((item) => item.id === taskId)) return
    set((s) => ({
      tasks: s.tasks.map((item) => (item.id === task.id ? task : item)),
      diffsByTask: Object.fromEntries(Object.entries(s.diffsByTask).filter(([id]) => id !== taskId))
    }))
  },

  /** A rework request carries an optional general note plus any pending line comments. */
  rejectIssue: async (taskId, issueId, comment, headCommit) => {
    const body = comment?.trim()
    const task = await window.anvil.tasks.rejectIssue({ taskId, issueId, headCommit: headCommit ?? null, ...(body ? { comment: body } : {}) })
    if (!get().tasks.some((item) => item.id === taskId)) return
    set((s) => ({
      tasks: s.tasks.map((item) => (item.id === task.id ? task : item)),
      diffsByTask: Object.fromEntries(Object.entries(s.diffsByTask).filter(([id]) => id !== taskId)),
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

  showHome: () => set({ ...evictTaskEvents(), view: { kind: 'home' } }),
  focusTaskComposer: () => set((state) => {
    if (!state.activeProjectId || state.settingsOpen || state.taskMenu || state.rebaseTaskId) return state
    return {
      ...evictTaskEvents(),
      view: { kind: 'home' },
      taskComposerFocusRequest: state.taskComposerFocusRequest + 1
    }
  }),

  applyEvent: (event) =>
    set((s) => {
      const history = s.taskEventHistory
      if (s.workspaceSwitching || s.view.kind !== 'task' || s.view.taskId !== event.taskId || !history) return s
      const existing = s.eventsByTask[event.taskId] ?? []
      // Production IPC always supplies sequence. Unknown ordering must never turn
      // an old snapshot into an apparent new tail event.
      const eventIndex = existing.findIndex((entry) => entry.id === event.id)
      const previous = existing[eventIndex]
      if (event.sequence === undefined && previous?.sequence === undefined) return s
      const ordered = { ...event, sequence: event.sequence ?? previous!.sequence }
      if (historyRequest) {
        const request = historyRequest
        request.newestLiveSequence = Math.max(request.newestLiveSequence, ordered.sequence!)
        // Keep only updates that can overlap the page. A background tail burst
        // must not evict an in-flight older page's snapshot overrides.
        if ((request.before === undefined || ordered.sequence! < request.before) &&
          (request.after === undefined || ordered.sequence! > request.after)) {
          request.live.set(event.id, ordered)
          if (request.live.size > MAX_LINES_IN_MEMORY) {
            let discard: TaskEvent = ordered
            for (const candidate of request.live.values()) {
              if (request.direction === 'newer'
                ? candidate.sequence! > discard.sequence!
                : candidate.sequence! < discard.sequence!) discard = candidate
            }
            request.live.delete(discard.id)
          }
        }
      }
      const beyondTail = ordered.sequence! > (history.newestCursor?.sequence ?? 0)
      const append = history.followingLatest && beyondTail
      if (!previous && !append) {
        if (!beyondTail || history.hasNewer) return s
        return { taskEventHistory: { ...history, hasNewer: true } }
      }
      const merged = previous ? existing.map((entry, index) => index === eventIndex ? ordered : entry) : [...existing, ordered]
      const events = merged.slice(-MAX_LINES_IN_MEMORY)
      return {
        eventsByTask: { [event.taskId]: events },
        taskEventHistory: { ...history, oldestCursor: eventCursor(events[0]), newestCursor: eventCursor(events.at(-1)),
          hasOlder: history.hasOlder || merged.length > events.length }
      }
    }),

  applyTaskUpdate: (task) =>
    set((s) => {
      const changed = taskDiffRevision(s.tasks.find((item) => item.id === task.id)) !== taskDiffRevision(task)
      if (changed) taskDiffRequests.delete(task.id)
      return {
        tasks: s.tasks.map((r) => (r.id === task.id ? task : r)),
        ...(changed ? {
          diffsByTask: Object.fromEntries(Object.entries(s.diffsByTask).filter(([id]) => id !== task.id)),
          diffErrorsByTask: Object.fromEntries(Object.entries(s.diffErrorsByTask).filter(([id]) => id !== task.id))
        } : {})
      }
    }),

  saveSettings: async (patch, destinationId) => {
    const workspaceId = destinationId ?? get().activeWorkspaceId
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
  setSettingsOpen: (open) => set((state) => {
    if (state.settingsOpen === open) return state
    return open
      ? { settingsOpen: true, settingsSection: 'general', settingsProjectId: state.activeProjectId }
      : { settingsOpen: false }
  })
}))
