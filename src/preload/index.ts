import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcArgs, IpcInvokeChannel, IpcRequests, IpcSendChannel } from '../shared/ipc-requests'
import type {
  Workspace,
  WorkspaceSnapshot,
  WorkspacePreferences,
  ComposerPreferences,
  WorkspaceSettingsChange,
  AgentDefinition,
  GitHubCredentialStatus,
  PullRequestInfo,
  PullRequestPreview,
  ProviderModelList,
  Project,
  ProjectGitStatus,
  ProjectBranches,
  ProjectFileList,
  Task,
  TaskComment,
  TaskDiff,
  TaskIssueSnapshot,
  TaskEvent,
  TaskMergePreview,
  Settings,
  Wallpaper,
  TerminalSnapshot
} from '../shared/types'

// Keep native-menu requests made while React is still loading.
let settingsOpenPending = false
let settingsOpenHandler: (() => void) | undefined
ipcRenderer.on('settings:open-requested', () => {
  if (settingsOpenHandler) settingsOpenHandler()
  else settingsOpenPending = true
})

function invoke<C extends IpcInvokeChannel, T>(channel: C, ...args: IpcArgs<C>): Promise<T> {
  return ipcRenderer.invoke(channel, ...args)
}

function send<C extends IpcSendChannel>(channel: C, input: IpcRequests[C]): void {
  ipcRenderer.send(channel, input)
}

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /** Drives the platform-dependent half of the keyboard shortcuts. */
  platform: process.platform,
  wallpapers: {
    directory: (): Promise<string> => invoke('wallpapers:directory'),
    list: (): Promise<Wallpaper[]> => invoke('wallpapers:list'),
    read: (id: string): Promise<string | null> => invoke('wallpapers:read', id)
  },
  settings: {
    onOpenRequested: (handler: () => void): (() => void) => {
      settingsOpenHandler = handler
      if (settingsOpenPending) {
        settingsOpenPending = false
        handler()
      }
      return () => { if (settingsOpenHandler === handler) settingsOpenHandler = undefined }
    },
    onChanged: (handler: (change: WorkspaceSettingsChange) => void): (() => void) => subscribe('settings:changed', handler),
    get: (workspaceId?: string): Promise<Settings> => invoke('settings:get', workspaceId),
    set: (workspaceId: string, patch: Partial<Settings>): Promise<Settings> => invoke('settings:set', { workspaceId, patch })
  },
  workspaces: {
    list: (): Promise<Workspace[]> => invoke('workspaces:list'),
    snapshot: (): Promise<WorkspaceSnapshot> => invoke('workspaces:snapshot'),
    create: (name: string): Promise<Workspace> => invoke('workspaces:create', name),
    rename: (workspaceId: string, name: string): Promise<Workspace> => invoke('workspaces:rename', { workspaceId, name }),
    select: (workspaceId: string): Promise<WorkspaceSnapshot> => invoke('workspaces:select', workspaceId),
    getPreferences: (workspaceId: string): Promise<WorkspacePreferences> => invoke('workspaces:preferences:get', workspaceId),
    setPreferences: (workspaceId: string, patch: Partial<WorkspacePreferences>): Promise<WorkspacePreferences> => invoke('workspaces:preferences:set', { workspaceId, patch }),
    importComposer: (composer: ComposerPreferences): Promise<WorkspacePreferences> => invoke('workspaces:composer:import', composer),
    onChanged: (handler: (workspaces: Workspace[]) => void): (() => void) => subscribe('workspaces:changed', handler),
    onSelected: (handler: (snapshot: WorkspaceSnapshot) => void): (() => void) => subscribe('workspaces:selected', handler),
    onPreferencesChanged: (handler: (change: { workspaceId: string; preferences: WorkspacePreferences }) => void): (() => void) => subscribe('workspaces:preferences:changed', handler)
  },
  github: {
    credentialStatus: (): Promise<GitHubCredentialStatus> => invoke('github:credential-status'),
    setToken: (token: string): Promise<GitHubCredentialStatus> => invoke('github:set-token', token),
    removeToken: (): Promise<GitHubCredentialStatus> => invoke('github:remove-token'),
    preview: (taskId: string): Promise<PullRequestPreview> => invoke('github:pr-preview', taskId),
    openPullRequest: (input: IpcRequests['github:open-pr']): Promise<PullRequestInfo> =>
      invoke('github:open-pr', input),
    draftField: (input: IpcRequests['github:draft-pr-field']): Promise<string> =>
      invoke('github:draft-pr-field', input),
    openUrl: (url: string): Promise<void> => invoke('github:open-pr-url', url)
  },
  agents: {
    list: (): Promise<AgentDefinition[]> => invoke('agents:list'),
    models: (agentId: string): Promise<ProviderModelList> =>
      invoke('agents:models', agentId)
  },
  projects: {
    onChanged: (handler: (projects: Project[]) => void): (() => void) => subscribe('projects:changed', handler),
    list: (): Promise<Project[]> => invoke('projects:list'),
    add: (): Promise<Project | null> => invoke('projects:add'),
    update: (input: IpcRequests['projects:update']): Promise<Project | undefined> => invoke('projects:update', input),
    remove: (id: string): Promise<Project[]> => invoke('projects:remove', id),
    reveal: (projectId: string): Promise<string> => invoke('projects:reveal', projectId),
    gitStatus: (id: string): Promise<ProjectGitStatus> =>
      invoke('projects:git-status', id),
    gitInit: (id: string): Promise<ProjectGitStatus> => invoke('projects:git-init', id),
    branches: (id: string): Promise<ProjectBranches> => invoke('projects:branches', id),
    files: (input: IpcRequests['projects:files']): Promise<ProjectFileList> => invoke('projects:files', input),
    checkout: (input: IpcRequests['projects:checkout']): Promise<ProjectBranches> => invoke('projects:checkout', input)
  },
  tasks: {
    list: (): Promise<Task[]> => invoke('tasks:list'),
    issues: (taskId: string): Promise<TaskIssueSnapshot | null> => invoke('tasks:issues', taskId),
    events: (taskId: string): Promise<TaskEvent[]> => invoke('tasks:events', taskId),
    diff: (taskId: string): Promise<TaskDiff> => invoke('tasks:diff', taskId),
    issueDiff: (input: IpcRequests['tasks:issue-diff']): Promise<TaskDiff> => invoke('tasks:issue-diff', input),
    start: (input: IpcRequests['tasks:start']): Promise<Task> => invoke('tasks:start', input),
    steer: (input: IpcRequests['tasks:steer']): Promise<void> => invoke('tasks:steer', input),
    cancel: (taskId: string): Promise<boolean> => invoke('tasks:cancel', taskId),
    delete: (taskId: string): Promise<void> => invoke('tasks:delete', taskId),
    settle: (taskId: string): Promise<Task> => invoke('tasks:settle', taskId),
    rebase: (input: IpcRequests['tasks:rebase']): Promise<Task> =>
      invoke('tasks:rebase', input),
    rebaseWithAgent: (taskId: string): Promise<Task> =>
      invoke('tasks:rebase-agent', taskId),
    mergePreview: (taskId: string): Promise<TaskMergePreview> => invoke('tasks:merge-preview', taskId),
    approve: (input: IpcRequests['tasks:approve']): Promise<Task> => invoke('tasks:approve', input),
    approveIssue: (taskId: string): Promise<Task> => invoke('tasks:approve-issue', taskId),
    rejectIssue: (input: IpcRequests['tasks:reject-issue']): Promise<Task> => invoke('tasks:reject-issue', input),
    onEvent: (handler: (event: TaskEvent) => void): (() => void) =>
      subscribe<TaskEvent>('task:event', handler),
    onUpdated: (handler: (task: Task) => void): (() => void) => subscribe<Task>('task:updated', handler)
  },
  comments: {
    list: (taskId: string): Promise<TaskComment[]> => invoke('comments:list', taskId),
    add: (input: IpcRequests['comments:add']): Promise<TaskComment[]> => invoke('comments:add', input),
    remove: (input: IpcRequests['comments:remove']): Promise<TaskComment[]> =>
      invoke('comments:remove', input),
    send: (taskId: string): Promise<{ task: Task; comments: TaskComment[] }> =>
      invoke('comments:send', taskId)
  },
  terminal: {
    ensure: (input: IpcRequests['terminal:ensure']): Promise<TerminalSnapshot> =>
      invoke('terminal:ensure', input),
    write: (projectId: string, data: string): void => send('terminal:write', { projectId, data }),
    resize: (projectId: string, cols: number, rows: number): void =>
      send('terminal:resize', { projectId, cols, rows }),
    onData: (handler: (payload: { id: string; data: string; sequence: number }) => void): (() => void) =>
      subscribe('terminal:data', handler),
    onExit: (handler: (payload: { id: string; code: number }) => void): (() => void) =>
      subscribe('terminal:exit', handler)
  }
}

contextBridge.exposeInMainWorld('anvil', api)

export type AnvilApi = typeof api
