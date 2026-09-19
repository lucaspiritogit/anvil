import { create } from 'zustand'
import { DEFAULT_TASK_EVENT_PAGE_SIZE, MAX_TASK_EVENT_PAGE_SIZE } from '@anvil/protocol/types'
import { hydrateComposer } from './composer-preferences'
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
  TaskMergeAndPushPreview,
  TaskMergeConflictSnapshot,
  TaskMergePreview,
  TaskPushPreview,
  Settings, Workspace, WorkspaceSnapshot, WorkspaceSettingsChange, TaskStyle, TaskReviewPolicy, TaskCheckoutMode,
  TaskResultNotice, TaskResultNoticeChange
} from '@anvil/protocol/types'
import { nextTaskStyle } from '@anvil/protocol/task-style'

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
let mergeConflictGeneration = 0
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
  mergeConflictGeneration += 1
  historyRequest?.live.clear()
  historyRequest = null
  return { eventsByTask: {}, taskEventHistory: null, mergeConflictState: null }
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
const modelRequests = new Map<string, Promise<void>>()
let workspaceGeneration = 0
const taskDiffRequests = new Map<string, { view: CenterView; revision: string; generation: number }>()
const taskDiffRevision = (task?: Task): string => JSON.stringify(task ? [
  task.workspaceId, task.status, task.deliveryStatus, task.branchName, task.baseCommit, task.headCommit,
  task.reviewPaths, task.filesChanged, task.additions, task.deletions
] : null)
type CaffeineSave = { value: boolean; status: 'pending' | 'error' }
type TaskResultNoticeError = { workspaceId: string; projectId: string; message: string }
export interface MergeConflictState {
  taskId: string
  conflictId: string
  snapshot?: TaskMergeConflictSnapshot
  loading: boolean
  error: string | null
  savingPath: string | null
  action: 'complete' | 'fix' | 'abort' | null
  revision: number
}

export type TaskPanel = 'output' | 'changes' | 'issues'
export type CenterView = { kind: 'home' } | { kind: 'analytics' } | { kind: 'task'; taskId: string; panel?: TaskPanel }

const sortTaskResultNotices = (notices: TaskResultNotice[]): TaskResultNotice[] => [...notices].sort(
  (a, b) => b.createdAt - a.createdAt || b.resultVersion - a.resultVersion || a.id.localeCompare(b.id)
)

const TASK_SEEN_STORAGE_KEY = 'anvil-task-seen-at'

const loadTaskSeenAt = (): Record<string, number> => {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(TASK_SEEN_STORAGE_KEY) ?? '{}')
    if (typeof stored !== 'object' || stored === null) return {}
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
  } catch {
    return {}
  }
}

const mergeTaskResultNotice = (current: TaskResultNotice | undefined, incoming: TaskResultNotice): TaskResultNotice => ({
  ...incoming,
  ...(current?.seenAt !== undefined && incoming.seenAt === undefined ? { seenAt: current.seenAt } : {}),
  ...(current?.dismissedAt !== undefined && incoming.dismissedAt === undefined ? { dismissedAt: current.dismissedAt } : {})
})

interface AnvilState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  workspaceSwitching: boolean
  workspaceError: string | null
  selectWorkspace: (workspaceId: string) => Promise<void>
  createWorkspace: (name: string) => Promise<void>
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>
  removeWorkspace: (workspaceId: string) => Promise<void>
  applyWorkspaceSnapshot: (snapshot: WorkspaceSnapshot) => void
  receiveWorkspaceSelection: (snapshot: WorkspaceSnapshot) => void
  applySettingsChange: (change: WorkspaceSettingsChange) => void
  ready: boolean
  projects: Project[]
  tasks: Task[]
  taskSeenAt: Record<string, number>
  markTaskSeen: (taskId: string) => void
  taskResultNotices: TaskResultNotice[]
  taskResultNoticeError: TaskResultNoticeError | null
  applyTaskResultNoticeChange: (change: TaskResultNoticeChange) => void
  markTaskResultNoticeSeen: (noticeId: string) => Promise<void>
  dismissTaskResultNotice: (noticeId: string) => Promise<void>
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
  mergeConflictState: MergeConflictState | null
  gitInitPending: string | null
  gitInitError: string | null

  taskComposerFocusRequest: number
  taskComposerStyle: TaskStyle
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
  addProject: (path: string) => Promise<Project | null>
  cloneProject: (url: string) => Promise<Project | null>
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
  mergeAndPushTask: (taskId: string, preview: TaskMergeAndPushPreview) => Promise<void>
  loadMergeConflict: (taskId: string, conflictId: string) => Promise<void>
  saveMergeConflict: (taskId: string, conflictId: string, path: string, contents: string, expectedContentsHash: string) => Promise<void>
  completeMergeConflict: (taskId: string, conflictId: string) => Promise<void>
  fixMergeConflictWithAgent: (taskId: string, conflictId: string) => Promise<void>
  abortMergeConflict: (taskId: string, conflictId: string) => Promise<void>
  pushTask: (taskId: string, preview: TaskPushPreview) => Promise<void>
  approveIssue: (taskId: string, issueId: string, headCommit: string | null) => Promise<void>
  rejectIssue: (taskId: string, issueId: string, headCommit: string | null) => Promise<void>
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
  startTask: (input: { projectId?: string; style?: TaskStyle; reviewPolicy?: TaskReviewPolicy; checkoutMode?: TaskCheckoutMode; startBase?: string; parentTaskId?: string; agentId: string; prompt: string; model?: string; reasoningEffort?: string; images?: TaskImageAttachment[]; fileReferences?: string[] }) => Promise<void>
  steerTask: (taskId: string, message: string) => Promise<void>
  cancelTask: (taskId: string) => Promise<void>
  openTask: (taskId: string, panel?: TaskPanel) => Promise<void>
  loadTaskDiff: (taskId: string) => Promise<void>
  loadIssueDiff: (taskId: string, issueId: string) => Promise<void>
  showHome: () => void
  showAnalytics: () => void
  focusTaskComposer: () => void
  setTaskComposerStyle: (style: TaskStyle) => void
  cycleTaskComposerStyle: () => void

  applyEvent: (event: TaskEvent) => void
  applyTaskUpdate: (task: Task) => void

  saveSettings: (patch: Partial<Settings>, workspaceId?: string) => Promise<void>
  toggleSidebar: () => void
  setSettingsOpen: (open: boolean) => void
}

const mergeConflictRequestIsCurrent = (
  get: () => AnvilState,
  generation: number,
  workspaceId: string | null,
  taskId: string,
  conflictId: string
): boolean => {
  const state = get()
  const task = state.tasks.find((item) => item.id === taskId)
  return generation === mergeConflictGeneration && workspaceId === state.activeWorkspaceId &&
    state.view.kind === 'task' && state.view.taskId === taskId &&
    task?.deliveryStatus === 'merge_conflict' && task.mergeConflict?.id === conflictId
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
    const workspaceView = view.kind === 'analytics' ? view : { kind: 'home' as const }
    set({
      workspaces: snapshot.workspaces, activeWorkspaceId: snapshot.workspace.id,
      settings: snapshot.settings, projects: snapshot.projects, tasks: snapshot.tasks,
      taskResultNotices: sortTaskResultNotices(snapshot.taskResultNotices.filter((notice) => notice.workspaceId === snapshot.workspace.id)),
      taskResultNoticeError: null,
      activeProjectId: snapshot.projects.find((project) => project.id === snapshot.preferences.lastProjectId)?.id ?? snapshot.projects[0]?.id ?? null,
      ready: true,
      ...(changed || removed ? { ...evictTaskEvents(), view: changed ? workspaceView : { kind: 'home' as const } } : {}),
      ...(changed ? {
        view: workspaceView, taskMenu: null, rebaseTaskId: null,
        taskComposerStyle: 'quick',
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
    const view = get().view
    set({ ...evictTaskEvents(), view: view.kind === 'analytics' ? view : { kind: 'home' }, workspaceSwitching: true, workspaceError: null })
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
  removeWorkspace: async (workspaceId) => {
    const generation = ++workspaceGeneration
    set({ ...evictTaskEvents(), workspaceSwitching: true, workspaceError: null })
    try {
      const snapshot = await enqueueWorkspaceRequest(() => window.anvil.workspaces.remove(workspaceId))
      if (generation === workspaceGeneration) get().applyWorkspaceSnapshot(snapshot)
    } catch (error) {
      if (generation === workspaceGeneration) set({ workspaceError: error instanceof Error ? error.message : 'Could not delete workspace' })
      throw error
    } finally {
      if (generation === workspaceGeneration) set({ workspaceSwitching: false })
    }
  },
  ready: false,
  projects: [],
  tasks: [],
  taskSeenAt: loadTaskSeenAt(),
  markTaskSeen: (taskId) => {
    set((state) => {
      const known = new Set(state.tasks.map((task) => task.id))
      const taskSeenAt = Object.fromEntries(Object.entries({ ...state.taskSeenAt, [taskId]: Date.now() })
        .filter(([id]) => known.has(id)))
      try { window.localStorage.setItem(TASK_SEEN_STORAGE_KEY, JSON.stringify(taskSeenAt)) } catch {}
      return { taskSeenAt }
    })
  },
  taskResultNotices: [],
  taskResultNoticeError: null,
  applyTaskResultNoticeChange: (change) => {
    if (get().workspaceSwitching || get().activeWorkspaceId !== change.workspaceId) return
    set((state) => {
      if (!change.notice) {
        return { taskResultNotices: state.taskResultNotices.filter((notice) => notice.id !== change.noticeId) }
      }
      if (change.notice.workspaceId !== change.workspaceId || change.notice.projectId !== change.projectId) return state
      const current = state.taskResultNotices.find((notice) => notice.id === change.noticeId)
      return {
        taskResultNotices: sortTaskResultNotices([
          mergeTaskResultNotice(current, change.notice),
          ...state.taskResultNotices.filter((notice) => notice.id !== change.noticeId)
        ]),
        taskResultNoticeError: null
      }
    })
  },
  markTaskResultNoticeSeen: async (noticeId) => {
    const workspaceId = get().activeWorkspaceId
    const projectId = get().taskResultNotices.find((notice) => notice.id === noticeId)?.projectId
    const generation = workspaceGeneration
    if (!workspaceId || !projectId || get().workspaceSwitching) return
    try {
      const notice = await window.anvil.taskResultNotices.markSeen({ workspaceId, noticeId })
      if (generation !== workspaceGeneration || get().activeWorkspaceId !== workspaceId) return
      get().applyTaskResultNoticeChange({ workspaceId, projectId: notice.projectId, noticeId, notice })
    } catch (error) {
      if (generation === workspaceGeneration && get().activeWorkspaceId === workspaceId) {
        set({ taskResultNoticeError: { workspaceId, projectId, message: error instanceof Error ? error.message : 'Could not acknowledge the task result' } })
      }
    }
  },
  dismissTaskResultNotice: async (noticeId) => {
    const workspaceId = get().activeWorkspaceId
    const projectId = get().taskResultNotices.find((notice) => notice.id === noticeId)?.projectId
    const generation = workspaceGeneration
    if (!workspaceId || !projectId || get().workspaceSwitching) return
    try {
      const current = get().taskResultNotices.find((notice) => notice.id === noticeId)
      if (current && current.seenAt === undefined) {
        const seen = await window.anvil.taskResultNotices.markSeen({ workspaceId, noticeId })
        if (generation !== workspaceGeneration || get().activeWorkspaceId !== workspaceId) return
        get().applyTaskResultNoticeChange({ workspaceId, projectId: seen.projectId, noticeId, notice: seen })
      }
      const notice = await window.anvil.taskResultNotices.dismiss({ workspaceId, noticeId })
      if (generation !== workspaceGeneration || get().activeWorkspaceId !== workspaceId) return
      get().applyTaskResultNoticeChange({ workspaceId, projectId: notice.projectId, noticeId, notice })
    } catch (error) {
      if (generation === workspaceGeneration && get().activeWorkspaceId === workspaceId) {
        set({ taskResultNoticeError: { workspaceId, projectId, message: error instanceof Error ? error.message : 'Could not dismiss the task result' } })
      }
    }
  },
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
  taskComposerStyle: 'quick',
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
  mergeConflictState: null,

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
        const [snapshot, agents] = await Promise.all([window.anvil.workspaces.snapshot(), window.anvil.agents.list()])
        if (generation !== workspaceGeneration) return
        set({ agents })
        get().applyWorkspaceSnapshot(snapshot)
        set({ workspaceError: null, workspaceSwitching: false })
      })
    } catch (error) {
      if (generation !== workspaceGeneration) return
      if (generation === workspaceGeneration) set({ workspaceError: error instanceof Error ? error.message : 'Could not load workspace' })
    }
  },

  addProject: async (path) => {
    const workspaceId = get().activeWorkspaceId
    const generation = workspaceGeneration
    const project = await window.anvil.projects.add(path, workspaceId ?? undefined)
    if (workspaceId) await enqueueWorkspaceRequest(() => window.anvil.workspaces.setPreferences(workspaceId, { lastProjectId: project.id }))
    if (generation !== workspaceGeneration) return null
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id) ? s.projects : [...s.projects, project],
      activeProjectId: project.id,
      taskComposerStyle: 'quick',
      ...evictTaskEvents(),
      view: { kind: 'home' }
    }))
    return project
  },

  cloneProject: async (url) => {
    const workspaceId = get().activeWorkspaceId
    const generation = workspaceGeneration
    const project = await window.anvil.projects.clone(url, workspaceId ?? undefined)
    if (workspaceId) await enqueueWorkspaceRequest(() => window.anvil.workspaces.setPreferences(workspaceId, { lastProjectId: project.id }))
    if (generation !== workspaceGeneration) return null
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id) ? s.projects : [...s.projects, project],
      activeProjectId: project.id,
      taskComposerStyle: 'quick',
      ...evictTaskEvents(),
      view: { kind: 'home' }
    }))
    return project
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
        taskResultNotices: s.taskResultNotices.filter((notice) => notice.projectId !== id),
        activeProjectId: s.activeProjectId === id ? (projects[0]?.id ?? null) : s.activeProjectId,
        ...(s.activeProjectId === id ? { taskComposerStyle: 'quick' as const } : {}),
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
    set({ ...evictTaskEvents(), activeProjectId: id, taskComposerStyle: 'quick', view: { kind: 'home' } })
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
    const current = (): boolean => get().activeWorkspaceId === workspaceId && modelGeneration === (modelGenerations.get(workspaceId) ?? 0)
    const requestKey = JSON.stringify([workspaceId, agentId, modelGeneration])
    if (get().modelsByAgent[agentId]) return
    const pending = modelRequests.get(requestKey)
    if (pending) return pending
    set({ loadingModelsAgentId: agentId })
    const request = (async () => {
      let list: ProviderModelList
      try {
        list = await window.anvil.agents.models(agentId, workspaceId)
      } catch (err) {
        list = { agentId, models: [], error: err instanceof Error ? err.message : String(err) }
      }
      if (!current()) return
      set((s) => ({
        modelsByAgent: { ...s.modelsByAgent, [agentId]: list },
        modelsByWorkspace: { ...s.modelsByWorkspace, [workspaceId]: { ...s.modelsByWorkspace[workspaceId], [agentId]: list } },
        ...(s.loadingModelsAgentId === agentId ? { loadingModelsAgentId: null } : {})
      }))
    })()
    modelRequests.set(requestKey, request)
    try {
      await request
    } finally {
      modelRequests.delete(requestKey)
    }
  },

  startTask: async ({ projectId: requestedProjectId, style, reviewPolicy, checkoutMode, startBase, parentTaskId, agentId, prompt, model, reasoningEffort, images, fileReferences }) => {
    if (get().workspaceSwitching || !get().ready) throw new Error('Workspace is still loading')
    const generation = workspaceGeneration
    const projectId = requestedProjectId ?? get().activeProjectId
    if (!projectId) throw new Error('Choose a project before starting a task')
    if (get().activeProjectId !== projectId) throw new Error('The selected project changed. Review the task and try again.')
    const view = get().view
    const task = await window.anvil.tasks.start({
      workspaceId: get().activeWorkspaceId ?? undefined,
      projectId, style, reviewPolicy, checkoutMode, parentTaskId, agentId, prompt, model,
      ...(startBase ? { startBase } : {}),
      ...(images?.length ? { images } : {}),
      ...(fileReferences?.length ? { fileReferences } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
    })
    if (generation !== workspaceGeneration) return
    set((s) => ({
      // SSE may deliver preparation, cancellation, or failure before the RPC
      // response arrives. The creation snapshot must not undo those updates.
      tasks: [s.tasks.find((item) => item.id === task.id) ?? task, ...s.tasks.filter((item) => item.id !== task.id)],
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
        taskResultNotices: state.taskResultNotices.filter((notice) => notice.taskId !== taskId),
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

  openTask: async (taskId, panel) => {
    const task = get().tasks.find((item) => item.id === taskId)
    if (!task) {
      get().showHome()
      return
    }
    const currentView = get().view
    if (currentView.kind !== 'task' || currentView.taskId !== taskId) {
      set({ ...evictTaskEvents(), activeProjectId: task.projectId, view: { kind: 'task', taskId, ...(panel ? { panel } : {}) } })
    }
    get().markTaskSeen(taskId)
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
    if (!get().tasks.some((item) => item.id === taskId)) return
    set((s) => ({
      tasks: s.tasks.map((item) => (item.id === task.id ? task : item)),
      diffsByTask: Object.fromEntries(Object.entries(s.diffsByTask).filter(([id]) => id !== taskId))
    }))
    void get().loadComments(taskId).catch((error: unknown) => {
      set({ commentError: error instanceof Error ? error.message : String(error) })
    })
  },

  rejectIssue: async (taskId, issueId, headCommit) => {
    const task = await window.anvil.tasks.rejectIssue({ taskId, issueId, headCommit })
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

  mergeAndPushTask: async (taskId, preview) => {
    const task = await window.anvil.tasks.mergeAndPush({ taskId, preview })
    set((s) => ({
      tasks: s.tasks.map((item) => (item.id === task.id ? task : item)),
      commentError: null
    }))
  },

  loadMergeConflict: async (taskId, conflictId) => {
    const generation = ++mergeConflictGeneration
    const workspaceId = get().activeWorkspaceId
    const current = get().mergeConflictState
    const revision = current?.taskId === taskId && current.conflictId === conflictId ? current.revision : 0
    set({
      mergeConflictState: {
        taskId,
        conflictId,
        ...(current?.taskId === taskId && current.conflictId === conflictId && current.snapshot
          ? { snapshot: current.snapshot }
          : {}),
        loading: true,
        error: null,
        savingPath: null,
        action: null,
        revision
      }
    })
    try {
      const snapshot = await window.anvil.tasks.mergeConflict({ taskId, conflictId })
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      set({ mergeConflictState: { taskId, conflictId, snapshot, loading: false, error: null, savingPath: null, action: null, revision: revision + 1 } })
    } catch (error) {
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      set({
        mergeConflictState: {
          taskId,
          conflictId,
          ...(current?.snapshot ? { snapshot: current.snapshot } : {}),
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          savingPath: null,
          action: null,
          revision
        }
      })
    }
  },

  saveMergeConflict: async (taskId, conflictId, path, contents, expectedContentsHash) => {
    const current = get().mergeConflictState
    if (current?.taskId !== taskId || current.conflictId !== conflictId || current.savingPath || current.action) return
    const generation = ++mergeConflictGeneration
    const workspaceId = get().activeWorkspaceId
    set({ mergeConflictState: { ...current, loading: false, error: null, savingPath: path } })
    try {
      const snapshot = await window.anvil.tasks.saveMergeConflict({ taskId, conflictId, path, contents, expectedContentsHash })
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      set({ mergeConflictState: { taskId, conflictId, snapshot, loading: false, error: null, savingPath: null, action: null, revision: current.revision + 1 } })
    } catch (error) {
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      const message = error instanceof Error ? error.message : String(error)
      set({ mergeConflictState: { ...current, loading: true, error: message, savingPath: null } })
      try {
        const snapshot = await window.anvil.tasks.mergeConflict({ taskId, conflictId })
        if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
        set({ mergeConflictState: { taskId, conflictId, snapshot, loading: false, error: message, savingPath: null, action: null, revision: current.revision + 1 } })
      } catch (refreshError) {
        if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
        const refreshMessage = refreshError instanceof Error ? refreshError.message : String(refreshError)
        set({ mergeConflictState: { ...current, loading: false, error: `${message} Could not refresh the conflicted files: ${refreshMessage}`, savingPath: null } })
      }
    }
  },

  completeMergeConflict: async (taskId, conflictId) => {
    const current = get().mergeConflictState
    if (current?.taskId !== taskId || current.conflictId !== conflictId || !current.snapshot?.canComplete || current.savingPath || current.action) return
    const generation = ++mergeConflictGeneration
    const workspaceId = get().activeWorkspaceId
    set({ mergeConflictState: { ...current, error: null, action: 'complete' } })
    try {
      const task = await window.anvil.tasks.completeMergeConflict({ taskId, conflictId })
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      mergeConflictGeneration += 1
      set((state) => ({
        tasks: state.tasks.map((item) => item.id === task.id ? task : item),
        mergeConflictState: null,
        commentError: null
      }))
    } catch (error) {
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      set({ mergeConflictState: { ...current, error: error instanceof Error ? error.message : String(error), action: null } })
    }
  },

  fixMergeConflictWithAgent: async (taskId, conflictId) => {
    const current = get().mergeConflictState
    if (current?.taskId !== taskId || current.conflictId !== conflictId || current.savingPath || current.action) return
    const generation = ++mergeConflictGeneration
    const workspaceId = get().activeWorkspaceId
    set({ mergeConflictState: { ...current, error: null, action: 'fix' } })
    try {
      const task = await window.anvil.tasks.fixMergeConflictWithAgent({ taskId, conflictId })
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      set((state) => ({
        tasks: state.tasks.map((item) => item.id === task.id ? task : item),
        commentError: null
      }))
      if (task.deliveryStatus !== 'merge_conflict' || task.mergeConflict?.id !== conflictId) {
        mergeConflictGeneration += 1
        set({ mergeConflictState: null })
        return
      }
      set({ mergeConflictState: { ...current, loading: true, error: null, savingPath: null, action: null } })
      const snapshot = await window.anvil.tasks.mergeConflict({ taskId, conflictId })
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      set({ mergeConflictState: { taskId, conflictId, snapshot, loading: false, error: null, savingPath: null, action: null, revision: current.revision + 1 } })
    } catch (error) {
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      set({ mergeConflictState: { ...current, error: error instanceof Error ? error.message : String(error), action: null } })
    }
  },

  abortMergeConflict: async (taskId, conflictId) => {
    const current = get().mergeConflictState
    if (current?.taskId !== taskId || current.conflictId !== conflictId || current.savingPath || current.action) return
    const generation = ++mergeConflictGeneration
    const workspaceId = get().activeWorkspaceId
    set({ mergeConflictState: { ...current, error: null, action: 'abort' } })
    try {
      const task = await window.anvil.tasks.abortMergeConflict({ taskId, conflictId })
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      mergeConflictGeneration += 1
      set((state) => ({
        tasks: state.tasks.map((item) => item.id === task.id ? task : item),
        mergeConflictState: null,
        commentError: null
      }))
    } catch (error) {
      if (!mergeConflictRequestIsCurrent(get, generation, workspaceId, taskId, conflictId)) return
      set({ mergeConflictState: { ...current, error: error instanceof Error ? error.message : String(error), action: null } })
    }
  },

  pushTask: async (taskId, preview) => {
    const task = await window.anvil.tasks.push({ taskId, preview })
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
  showAnalytics: () => set({ ...evictTaskEvents(), view: { kind: 'analytics' } }),
  focusTaskComposer: () => set((state) => {
    if (!state.activeProjectId || state.settingsOpen || state.taskMenu || state.rebaseTaskId) return state
    return {
      ...evictTaskEvents(),
      view: { kind: 'home' },
      taskComposerFocusRequest: state.taskComposerFocusRequest + 1
    }
  }),
  setTaskComposerStyle: (style) => set({ taskComposerStyle: style }),
  cycleTaskComposerStyle: () => set((state) => {
    if (!state.activeProjectId || state.settingsOpen || state.taskMenu || state.rebaseTaskId) return state
    return {
      ...evictTaskEvents(),
      view: { kind: 'home' },
      taskComposerStyle: nextTaskStyle(state.taskComposerStyle),
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
      if (task.workspaceId !== s.activeWorkspaceId) return s
      const existingTask = s.tasks.find((item) => item.id === task.id)
      const changed = taskDiffRevision(existingTask) !== taskDiffRevision(task)
      const conflictChanged = existingTask?.mergeConflict?.id !== task.mergeConflict?.id ||
        existingTask?.deliveryStatus !== task.deliveryStatus
      if (changed) taskDiffRequests.delete(task.id)
      if (conflictChanged && s.mergeConflictState?.taskId === task.id) mergeConflictGeneration += 1
      return {
        // Other clients learn about newly created tasks through this event.
        tasks: existingTask
          ? s.tasks.map((item) => (item.id === task.id ? task : item))
          : [task, ...s.tasks],
        ...(changed ? {
          diffsByTask: Object.fromEntries(Object.entries(s.diffsByTask).filter(([id]) => id !== task.id)),
          diffErrorsByTask: Object.fromEntries(Object.entries(s.diffErrorsByTask).filter(([id]) => id !== task.id))
        } : {}),
        ...(conflictChanged && s.mergeConflictState?.taskId === task.id ? { mergeConflictState: null } : {})
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
