import { createHttpClient } from './http-client'
import type { TerminalSnapshot, TerminalOutput, TerminalExit } from '@anvil/protocol/terminal'
import type { WorkspaceAgentAccount } from '@anvil/protocol/types'
import { type AppReadiness } from '@anvil/protocol/app-lifecycle'
import { createEventLatch } from '@anvil/protocol/event-latch'
import type { IpcRequests } from '@anvil/protocol/ipc-requests'
import type { BrowserObservationLayout, BrowserObservationState, BrowserViewportRequest } from '@anvil/protocol/browser-observation'
import type { DesktopServerConnectionState } from '@anvil/protocol/desktop-requests'
import type { ServerTarget } from '@anvil/protocol/server-address'
import type {
  Workspace,
  WorkspaceSnapshot,
  WorkspacePreferences,
  WorkspaceSettingsChange,
  AgentDefinition,
  AnalyticsRange,
  AgentRateLimitsByAgent,
  AgentRateLimitTarget,
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
  ProjectFolderListing,
  Task,
  TaskComment,
  TaskDiff,
  TaskIssueSnapshot,
  TaskEvent,
  TaskEventsRequest,
  TaskEventsPage,
  TaskMergeAndPushPreview,
  TaskMergeConflictSnapshot,
  TaskMergePreview,
  TaskPushPreview,
  BranchSyncStatus,
  TaskResultNotice,
  TaskResultNoticeChange,
  Settings,
  Wallpaper,
  WallpaperUpload,
  WorkspaceAnalytics
} from '@anvil/protocol/types'

export interface ClientHost {
  platform: string
  onSettingsOpen(handler: () => void): () => void
  pickWallpaper(): Promise<string | null>
  pickProjectFolder?(): Promise<ProjectFolderSelection | null>
  openPath(path: string): Promise<string>
  openPullRequest(url: string): Promise<void>
  openLoginUrl(url: string): Promise<void>
  browserState(taskId: string): Promise<BrowserObservationState>
  browserLayout(layout: BrowserObservationLayout): Promise<void>
  browserViewport(input: BrowserViewportRequest): Promise<BrowserObservationState>
  onBrowserChanged(handler: (state: BrowserObservationState) => void): () => void
  serverTarget?(): Promise<DesktopServerConnectionState>
  setServerTarget?(target: ServerTarget): Promise<DesktopServerConnectionState>
}

export type ProjectFolderSelection =
  | { name: string; path: string }
  | { name: string; entries: ProjectFolderEntry[]; dispose?: () => Promise<void> }

export interface ProjectFolderEntry {
  path: string
  type: 'file' | 'directory'
  size: number
  executable?: boolean
  read?: (offset: number, length: number) => Promise<Uint8Array>
}

const PROJECT_IMPORT_CHUNK_SIZE = 4 * 1024 * 1024

export function createAnvilApi(url: string, host: ClientHost) {
  const appReadiness = createEventLatch<AppReadiness>()
  const client = createHttpClient(url,
    () => appReadiness.deliver({ ok: true }),
    (message) => appReadiness.deliver({ ok: false, message }))
  const { invoke, subscribe } = client
  subscribe<string>('open-url', (value) => {
    void host.openLoginUrl(value).catch((error) => console.error('Could not open sign-in:', error))
  })
  window.addEventListener('unload', () => client.close())

  const importProjectFromDisk = async (
    workspaceId: string,
    onProgress: (done: number, total: number) => void
  ): Promise<Project | null> => {
    if (!host.pickProjectFolder) throw new Error('This client cannot open folders from disk')
    const folder = await host.pickProjectFolder()
    if (!folder) return null
    if ('path' in folder) return invoke('projects:add', { path: folder.path, workspaceId })

    let importId: string | undefined
    try {
      const entries = folder.entries.map(({ path, type, size, executable }) => ({ path, type, size, executable }))
      const total = entries.reduce((size, entry) => size + (entry.type === 'file' ? entry.size : 0), 0)
      const started: { importId: string } = await invoke('projects:import-begin', {
        workspaceId,
        name: folder.name,
        entries
      })
      importId = started.importId
      let uploaded = 0
      onProgress(uploaded, total)

      for (const [index, entry] of folder.entries.entries()) {
        if (entry.type !== 'file') continue
        if (!entry.read) throw new Error(`Cannot read ${entry.path} from the selected folder`)

        for (let offset = 0; offset < entry.size; offset += PROJECT_IMPORT_CHUNK_SIZE) {
          const length = Math.min(PROJECT_IMPORT_CHUNK_SIZE, entry.size - offset)
          const bytes = await entry.read(offset, length)
          if (bytes.length !== length) throw new Error(`Could not read all of ${entry.path}`)
          await client.uploadProjectChunk(importId, index, offset, bytes)
          uploaded += bytes.length
          onProgress(uploaded, total)
        }
      }

      const project: Project = await invoke('projects:import-finish', importId)
      importId = undefined
      return project
    } catch (error) {
      if (importId) await invoke('projects:import-cancel', importId).catch(() => {})
      throw error
    } finally {
      await folder.dispose?.().catch(() => {})
    }
  }

  return {
    /** Drives the platform-dependent half of the keyboard shortcuts. */
    platform: host.platform,
    app: {
      onReady: (handler: () => void): (() => void) =>
        appReadiness.subscribe((readiness) => { if (readiness.ok) handler() }),
      onInitFailed: (handler: (message: string) => void): (() => void) =>
        appReadiness.subscribe((readiness) => { if (!readiness.ok) handler(readiness.message) })
    },
    browser: {
      state: host.browserState,
      layout: host.browserLayout,
      viewport: host.browserViewport,
      onChanged: host.onBrowserChanged
    },
    ...(host.serverTarget && host.setServerTarget ? { serverConnection: {
      get: host.serverTarget,
      set: host.setServerTarget
    } } : {}),
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
        const path: string | null = await host.pickWallpaper()
        return path ? invoke('wallpapers:import', { path, workspaceId }) : null
      },
      upload: (upload: WallpaperUpload, workspaceId?: string): Promise<Wallpaper> => invoke('wallpapers:upload', { ...upload, workspaceId }),
      read: (id: string, workspaceId?: string): Promise<string | null> => invoke('wallpapers:read', workspaceId ? { id, workspaceId } : id)
    },
    settings: {
      onOpenRequested: host.onSettingsOpen,
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
      remove: (workspaceId: string): Promise<WorkspaceSnapshot> => invoke('workspaces:remove', workspaceId),
      select: (workspaceId: string): Promise<WorkspaceSnapshot> => invoke('workspaces:select', workspaceId),
      getPreferences: (workspaceId: string): Promise<WorkspacePreferences> => invoke('workspaces:preferences:get', workspaceId),
      setPreferences: (workspaceId: string, patch: Partial<WorkspacePreferences>): Promise<WorkspacePreferences> => invoke('workspaces:preferences:set', { workspaceId, patch }),
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
        await host.openPullRequest(validated)
      }
    },
    accounts: {
      status: (input: IpcRequests['accounts:status']): Promise<WorkspaceAgentAccount> => invoke('accounts:status', input),
      rateLimits: <Agent extends keyof AgentRateLimitsByAgent>(input: AgentRateLimitTarget<Agent>): Promise<AgentRateLimitsByAgent[Agent]> => invoke('accounts:rate-limits', input),
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
    analytics: {
      get: (range: AnalyticsRange): Promise<WorkspaceAnalytics> => invoke('analytics:get', range)
    },
    projects: {
      onChanged: (handler: (projects: Project[]) => void): (() => void) => subscribe('projects:changed', handler),
      list: (): Promise<Project[]> => invoke('projects:list'),
      canPickFromDisk: !!host.pickProjectFolder,
      importFromDisk: importProjectFromDisk,
      browse: (path?: string): Promise<ProjectFolderListing> => invoke('projects:browse', path ? { path } : {}),
      add: (path: string, workspaceId?: string): Promise<Project> => invoke('projects:add', { path, ...(workspaceId ? { workspaceId } : {}) }),
      clone: (url: string, workspaceId?: string): Promise<Project> => invoke('projects:clone', { url, ...(workspaceId ? { workspaceId } : {}) }),
      update: (input: IpcRequests['projects:update']): Promise<Project | undefined> => invoke('projects:update', input),
      remove: (id: string): Promise<Project[]> => invoke('projects:remove', id),
      reveal: async (projectId: string): Promise<string> => {
        const path: string = await invoke('projects:reveal', projectId)
        return host.openPath(path)
      },
      gitStatus: (id: string): Promise<ProjectGitStatus> =>
        invoke('projects:git-status', id),
      gitInit: (id: string): Promise<ProjectGitStatus> => invoke('projects:git-init', id),
      branches: (id: string): Promise<ProjectBranches> => invoke('projects:branches', id),
      files: (input: IpcRequests['projects:files']): Promise<ProjectFileList> => invoke('projects:files', input),
      checkout: (input: IpcRequests['projects:checkout']): Promise<ProjectBranches> => invoke('projects:checkout', input),
      createBranch: (input: IpcRequests['projects:create-branch']): Promise<ProjectBranches> => invoke('projects:create-branch', input)
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
      mergeAndPushPreview: (taskId: string): Promise<TaskMergeAndPushPreview> => invoke('tasks:merge-and-push-preview', taskId),
      mergeAndPush: (input: IpcRequests['tasks:merge-and-push']): Promise<Task> => invoke('tasks:merge-and-push', input),
      mergeConflict: (input: IpcRequests['tasks:merge-conflict']): Promise<TaskMergeConflictSnapshot> =>
        invoke('tasks:merge-conflict', input),
      saveMergeConflict: (input: IpcRequests['tasks:merge-conflict-save']): Promise<TaskMergeConflictSnapshot> =>
        invoke('tasks:merge-conflict-save', input),
      completeMergeConflict: (input: IpcRequests['tasks:merge-conflict-complete']): Promise<Task> =>
        invoke('tasks:merge-conflict-complete', input),
      fixMergeConflictWithAgent: (input: IpcRequests['tasks:merge-conflict-fix-agent']): Promise<Task> =>
        invoke('tasks:merge-conflict-fix-agent', input),
      abortMergeConflict: (input: IpcRequests['tasks:merge-conflict-abort']): Promise<Task> =>
        invoke('tasks:merge-conflict-abort', input),
      pushPreview: (taskId: string): Promise<TaskPushPreview> => invoke('tasks:push-preview', taskId),
      push: (input: IpcRequests['tasks:push']): Promise<Task> => invoke('tasks:push', input),
      syncStatus: (taskId: string): Promise<BranchSyncStatus> => invoke('tasks:sync-status', taskId),
      pull: (input: IpcRequests['tasks:pull']): Promise<BranchSyncStatus> => invoke('tasks:pull', input),
      commitQuick: (input: IpcRequests['tasks:commit-quick']): Promise<Task> => invoke('tasks:commit-quick', input),
      draftCommitMessage: (input: IpcRequests['tasks:draft-commit-message']): Promise<string> =>
        invoke('tasks:draft-commit-message', input),
      approveIssue: (input: IpcRequests['tasks:approve-issue']): Promise<Task> => invoke('tasks:approve-issue', input),
      rejectIssue: (input: IpcRequests['tasks:reject-issue']): Promise<Task> => invoke('tasks:reject-issue', input),
      onEvent: (handler: (event: TaskEvent) => void): (() => void) =>
        subscribe<TaskEvent>('task:event', handler),
      onUpdated: (handler: (task: Task) => void): (() => void) => subscribe<Task>('task:updated', handler),
      onDeleted: (handler: (taskId: string) => void): (() => void) => subscribe<string>('task:deleted', handler)
    },
    taskResultNotices: {
      list: (input: IpcRequests['task-result-notices:list']): Promise<TaskResultNotice[]> =>
        invoke('task-result-notices:list', input),
      markSeen: (input: IpcRequests['task-result-notices:seen']): Promise<TaskResultNotice> =>
        invoke('task-result-notices:seen', input),
      dismiss: (input: IpcRequests['task-result-notices:dismiss']): Promise<TaskResultNotice> =>
        invoke('task-result-notices:dismiss', input),
      onChanged: (handler: (change: TaskResultNoticeChange) => void): (() => void) =>
        subscribe('task-result-notice:changed', handler)
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

}

export type AnvilApi = ReturnType<typeof createAnvilApi>
