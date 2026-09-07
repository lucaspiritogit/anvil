import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentDefinition,
  GitHubCredentialStatus,
  PullRequestField,
  PullRequestInfo,
  PullRequestPreview,
  ProviderModelList,
  RebaseStep,
  Project,
  ProjectGitStatus,
  Task,
  TaskComment,
  TaskDiff,
  TaskEvent,
  TaskMergePreview,
  Settings
} from '../shared/types'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /** Drives the platform-dependent half of the keyboard shortcuts. */
  platform: process.platform,
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch)
  },
  github: {
    credentialStatus: (): Promise<GitHubCredentialStatus> => ipcRenderer.invoke('github:credential-status'),
    setToken: (token: string): Promise<GitHubCredentialStatus> => ipcRenderer.invoke('github:set-token', token),
    removeToken: (): Promise<GitHubCredentialStatus> => ipcRenderer.invoke('github:remove-token'),
    preview: (taskId: string): Promise<PullRequestPreview> => ipcRenderer.invoke('github:pr-preview', taskId),
    openPullRequest: (input: { taskId: string; preview: PullRequestPreview; title: string; description: string }): Promise<PullRequestInfo> =>
      ipcRenderer.invoke('github:open-pr', input),
    draftField: (input: { taskId: string; field: PullRequestField; title: string; description: string }): Promise<string> =>
      ipcRenderer.invoke('github:draft-pr-field', input),
    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('github:open-pr-url', url)
  },
  agents: {
    list: (): Promise<AgentDefinition[]> => ipcRenderer.invoke('agents:list'),
    models: (agentId: string): Promise<ProviderModelList> =>
      ipcRenderer.invoke('agents:models', agentId)
  },
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    add: (): Promise<Project | null> => ipcRenderer.invoke('projects:add'),
    update: (input: {
      id: string
      monthlyTokenLimit: number | null
      monthlyCostLimitUsd: number | null
      finishOnPush: boolean
    }): Promise<Project | undefined> => ipcRenderer.invoke('projects:update', input),
    remove: (id: string): Promise<Project[]> => ipcRenderer.invoke('projects:remove', id),
    reveal: (path: string): Promise<string> => ipcRenderer.invoke('projects:reveal', path),
    gitStatus: (id: string): Promise<ProjectGitStatus> =>
      ipcRenderer.invoke('projects:git-status', id),
    gitInit: (id: string): Promise<ProjectGitStatus> => ipcRenderer.invoke('projects:git-init', id)
  },
  tasks: {
    list: (): Promise<Task[]> => ipcRenderer.invoke('tasks:list'),
    events: (taskId: string): Promise<TaskEvent[]> => ipcRenderer.invoke('tasks:events', taskId),
    diff: (taskId: string): Promise<TaskDiff> => ipcRenderer.invoke('tasks:diff', taskId),
    start: (input: {
      projectId: string
      agentId: string
      prompt: string
      model?: string
      reasoningEffort?: string
    }): Promise<Task> => ipcRenderer.invoke('tasks:start', input),
    steer: (input: { taskId: string; message: string }): Promise<void> => ipcRenderer.invoke('tasks:steer', input),
    cancel: (taskId: string): Promise<boolean> => ipcRenderer.invoke('tasks:cancel', taskId),
    delete: (taskId: string): Promise<void> => ipcRenderer.invoke('tasks:delete', taskId),
    settle: (taskId: string): Promise<Task> => ipcRenderer.invoke('tasks:settle', taskId),
    rebase: (input: { taskId: string; steps: RebaseStep[] }): Promise<Task> =>
      ipcRenderer.invoke('tasks:rebase', input),
    rebaseWithAgent: (taskId: string): Promise<Task> =>
      ipcRenderer.invoke('tasks:rebase-agent', taskId),
    mergePreview: (taskId: string): Promise<TaskMergePreview> => ipcRenderer.invoke('tasks:merge-preview', taskId),
    approve: (input: { taskId: string; preview: TaskMergePreview }): Promise<Task> => ipcRenderer.invoke('tasks:approve', input),
    onEvent: (handler: (event: TaskEvent) => void): (() => void) =>
      subscribe<TaskEvent>('task:event', handler),
    onUpdated: (handler: (task: Task) => void): (() => void) => subscribe<Task>('task:updated', handler)
  },
  comments: {
    list: (taskId: string): Promise<TaskComment[]> => ipcRenderer.invoke('comments:list', taskId),
    add: (input: {
      taskId: string
      file: string
      side: TaskComment['side']
      lineNumber: number
      body: string
    }): Promise<TaskComment[]> => ipcRenderer.invoke('comments:add', input),
    remove: (input: { taskId: string; id: string }): Promise<TaskComment[]> =>
      ipcRenderer.invoke('comments:remove', input),
    send: (taskId: string): Promise<{ task: Task; comments: TaskComment[] }> =>
      ipcRenderer.invoke('comments:send', taskId)
  },
  terminal: {
    ensure: (input: { id: string; cwd: string; cols: number; rows: number }): Promise<boolean> =>
      ipcRenderer.invoke('terminal:ensure', input),
    write: (id: string, data: string): void => ipcRenderer.send('terminal:write', { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('terminal:resize', { id, cols, rows }),
    onData: (handler: (payload: { id: string; data: string }) => void): (() => void) =>
      subscribe('terminal:data', handler),
    onExit: (handler: (payload: { id: string; code: number }) => void): (() => void) =>
      subscribe('terminal:exit', handler)
  }
}

contextBridge.exposeInMainWorld('anvil', api)

export type AnvilApi = typeof api
