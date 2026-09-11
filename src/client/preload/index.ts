import { createHttpClient } from './http-client'
import { serverAddress } from '../../shared/server-address'
import type { TerminalSnapshot, TerminalOutput, TerminalExit } from '../../shared/terminal'
import type { WorkspaceAgentAccount } from '../../shared/types'
import { contextBridge, ipcRenderer } from 'electron'
import { type AppReadiness } from '../../shared/app-lifecycle'
import { createEventLatch } from '../../shared/event-latch'
import type { IpcRequests } from '../../shared/ipc-requests'
import type {
  Workspace,
  WorkspaceSnapshot,
  WorkspacePreferences,
  ComposerPreferences,
  WorkspaceSettingsChange,
  AgentDefinition,
  GitHubCredentialStatus,
  ConnectionsStatus,
  ConnectionsStatusChange,
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
  TaskEventsRequest,
  TaskEventsPage,
  TaskMergePreview,
  Settings,
  Wallpaper
} from '../../shared/types'

// Keep native-menu requests made while React is still loading.
let settingsOpenPending = false
let settingsOpenHandler: (() => void) | undefined
ipcRenderer.on('settings:open-requested', () => {
  if (settingsOpenHandler) settingsOpenHandler()
  else settingsOpenPending = true
})

// Keep startup readiness available if main finishes before React subscribes.
const appReadiness = createEventLatch<AppReadiness>()
const argument = process.argv.find((value) => value.startsWith('--anvil-server-url='))
const url = serverAddress(argument?.slice('--anvil-server-url='.length) ?? 'http://127.0.0.1:4780')
const client = createHttpClient(url,
  () => appReadiness.deliver({ ok: true }),
  (message) => appReadiness.deliver({ ok: false, message }))
const { invoke, subscribe } = client
subscribe<string>('open-url', (value) => {
  void ipcRenderer.invoke('desktop:open-login-url', value).catch((error) => console.error('Could not open sign-in:', error))
})
window.addEventListener('unload', () => client.close())

const api = {
  /** Drives the platform-dependent half of the keyboard shortcuts. */
  platform: process.platform,
  app: {
    onReady: (handler: () => void): (() => void) =>
      appReadiness.subscribe((readiness) => { if (readiness.ok) handler() }),
    onInitFailed: (handler: (message: string) => void): (() => void) =>
      appReadiness.subscribe((readiness) => { if (!readiness.ok) handler(readiness.message) })
  },
  terminals: {
    create: (input: IpcRequests['terminals:create']): Promise<{ sessionId: string }> => invoke('terminals:create', input),
    attach: (sessionId: string): Promise<TerminalSnapshot> => invoke('terminals:attach', sessionId),
    write: (input: IpcRequests['terminals:write']): Promise<void> => invoke('terminals:write', input),
    resize: (input: IpcRequests['terminals:resize']): Promise<void> => invoke('terminals:resize', input),
    dispose: (sessionId: string): Promise<void> => invoke('terminals:dispose', sessionId),
    onOutput: (handler: (output: TerminalOutput) => void): (() => void) => subscribe('terminals:output', handler),
    onExit: (handler: (exit: TerminalExit) => void): (() => void) => subscribe('terminals:exit', handler)
  },
  wallpapers: {
    directory: (workspaceId?: string): Promise<string> => invoke('wallpapers:directory', workspaceId),
    list: (workspaceId?: string): Promise<Wallpaper[]> => invoke('wallpapers:list', workspaceId),
    importImage: async (workspaceId?: string): Promise<Wallpaper | null> => {
      const path: string | null = await ipcRenderer.invoke('desktop:pick-wallpaper')
      return path ? invoke('wallpapers:import', { path, workspaceId }) : null
    },
    read: (id: string, workspaceId?: string): Promise<string | null> => invoke('wallpapers:read', workspaceId ? { id, workspaceId } : id)
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
  connections: {
    status: (workspaceId?: string): Promise<ConnectionsStatus> => invoke('connections:status', workspaceId),
    configure: (input: IpcRequests['connections:configure']): Promise<ConnectionsStatus> => invoke('connections:configure', input),
    onChanged: (handler: (change: ConnectionsStatusChange) => void): (() => void) => subscribe('connections:changed', handler)
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
    openUrl: async (url: string): Promise<void> => {
      const validated: string = await invoke('github:open-pr-url', url)
      await ipcRenderer.invoke('desktop:open-pr-url', validated)
    }
  },
  accounts: {
    status: (input: IpcRequests['accounts:status']): Promise<WorkspaceAgentAccount> => invoke('accounts:status', input),
    connect: (input: IpcRequests['accounts:connect']): Promise<WorkspaceAgentAccount> => invoke('accounts:connect', input),
    disconnect: (input: IpcRequests['accounts:disconnect']): Promise<WorkspaceAgentAccount> => invoke('accounts:disconnect', input),
    cancel: (input: IpcRequests['accounts:cancel']): Promise<WorkspaceAgentAccount> => invoke('accounts:cancel', input),
    onChanged: (handler: (state: WorkspaceAgentAccount) => void): (() => void) => subscribe('accounts:changed', handler)
  },
  agents: {
    list: (): Promise<AgentDefinition[]> => invoke('agents:list'),
    models: (agentId: string, workspaceId?: string): Promise<ProviderModelList> =>
      invoke('agents:models', { agentId, workspaceId }),
    onModelsChanged: (handler: (workspaceId: string) => void): (() => void) => subscribe('agents:models:changed', handler)
  },
  projects: {
    onChanged: (handler: (projects: Project[]) => void): (() => void) => subscribe('projects:changed', handler),
    list: (): Promise<Project[]> => invoke('projects:list'),
    add: async (): Promise<Project | null> => {
      const path: string | null = await ipcRenderer.invoke('desktop:pick-project')
      return path ? invoke('projects:add', { path }) : null
    },
    update: (input: IpcRequests['projects:update']): Promise<Project | undefined> => invoke('projects:update', input),
    remove: (id: string): Promise<Project[]> => invoke('projects:remove', id),
    reveal: async (projectId: string): Promise<string> => {
      const path: string = await invoke('projects:reveal', projectId)
      return ipcRenderer.invoke('desktop:open-path', path)
    },
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
    eventsPage: (input: TaskEventsRequest): Promise<TaskEventsPage> => invoke('tasks:events-page', input),
    diff: (taskId: string): Promise<TaskDiff> => invoke('tasks:diff', taskId),
    issueDiff: (input: IpcRequests['tasks:issue-diff']): Promise<TaskDiff> => invoke('tasks:issue-diff', input),
    start: (input: IpcRequests['tasks:start']): Promise<Task> => invoke('tasks:start', input),
    steer: (input: IpcRequests['tasks:steer']): Promise<void> => invoke('tasks:steer', input),
    compact: (taskId: string): Promise<void> => invoke('tasks:compact', taskId),
    stack: (input: IpcRequests['tasks:stack']): Promise<Task> => invoke('tasks:stack', input),
    dismissStack: (taskId: string): Promise<Task> => invoke('tasks:stack-dismiss', taskId),
    restack: (taskId: string): Promise<Task> => invoke('tasks:restack', taskId),
    cancel: (taskId: string): Promise<boolean> => invoke('tasks:cancel', taskId),
    delete: (taskId: string): Promise<void> => invoke('tasks:delete', taskId),
    settle: (taskId: string): Promise<Task> => invoke('tasks:settle', taskId),
    rebase: (input: IpcRequests['tasks:rebase']): Promise<Task> =>
      invoke('tasks:rebase', input),
    rebaseWithAgent: (taskId: string): Promise<Task> =>
      invoke('tasks:rebase-agent', taskId),
    mergePreview: (taskId: string): Promise<TaskMergePreview> => invoke('tasks:merge-preview', taskId),
    approve: (input: IpcRequests['tasks:approve']): Promise<Task> => invoke('tasks:approve', input),
    approveIssue: (input: IpcRequests['tasks:approve-issue']): Promise<Task> => invoke('tasks:approve-issue', input),
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
  }
}

contextBridge.exposeInMainWorld('anvil', api)

export type AnvilApi = typeof api
