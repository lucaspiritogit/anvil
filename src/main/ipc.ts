import { WorkspaceAccounts } from './agents/workspace-accounts'
import { registerAccountHandlers } from './ipc/agent-accounts'
import { openExternalCodexLogin } from './renderer-security'
import { invalidateWorkspaceModels, closeModelDiscovery, pauseWorkspaceModelDiscovery } from './agents/models'
import { watchWorkspaceAuthChanges } from './agents/workspace-auth-changes'
import { resolveTaskWorkspace } from './agents/workspace-execution'
import { WallpaperLibrary } from './wallpapers'
import { app, BrowserWindow, powerSaveBlocker } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerCaffeineMode } from './caffeine-mode'
import { AgentProcessManager } from './agents/process-manager'
import { GitDeliveryManager } from './git-delivery'
import { registerAgentHandlers } from './ipc/agents'
import { registerGitHubHandlers } from './ipc/github'
import { GitHubCredentials } from './github-credentials'
import { GitHubPRPolling } from './github-pr-polling'
import { GitHubClient } from './github-client'
import { registerProjectHandlers } from './ipc/projects'
import { registerRebaseHandlers } from './ipc/rebase'
import { registerReviewHandlers } from './ipc/review'
import { registerTaskHandlers } from './ipc/tasks'
import { registerSteeringHandlers } from './ipc/steering'
import { registerWorkspaceHandlers } from './ipc/workspaces'
import { registerSettingsHandlers } from './ipc/settings'
import { registerTerminalHandlers } from './ipc/terminals'
import { createProjectMemory, type ProjectMemory } from './memory/project-memory'
import { WorkspaceProjectMemory } from './memory/workspace-project-memory'
import { createTaskMemory } from './memory/task-memory'
import { createTaskCompletion } from './tasks/completion'
import type { SendToRenderer } from './tasks/context'
import { registerTaskEvents } from './tasks/events'
import { registerTaskExecution } from './tasks/task-execution'
import { Store } from './store'
import { TerminalManager } from './terminal'
import { createRendererIpc } from './renderer-security'
import { resolveAppDataDirectory } from './app-data'

/** Creates main-process dependencies and registers their IPC handlers. */
export function registerIpc(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
  dataDirectory = resolveAppDataDirectory(app.getPath('home'), app.isPackaged, process.env.ANVIL_DATA_DIR)
): {
  agentProcesses: AgentProcessManager
  terminals: TerminalManager
  projectMemory?: ProjectMemory
  githubPolling: Pick<GitHubPRPolling, 'refreshIfStale' | 'close'>
  stopCaffeineMode(): void
  closeAgentDiscovery(): Promise<void>
  closeStore(): void
} {
  const ipc = createRendererIpc(getWindow, rendererUrl)
  const broadcast = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }
  // Migrations ship under the app root in development and packaged builds.
  const store = new Store(join(dataDirectory, 'config.json'), {
    migrationsFolder: join(app.getAppPath(), 'src', 'main', 'db', 'migrations')
  })
  const agentProcesses = new AgentProcessManager(undefined, undefined, undefined, (taskId) => resolveTaskWorkspace(store, taskId))
  const stopCaffeineMode = registerCaffeineMode(store, powerSaveBlocker)
  const worktreeOwners = new Map<string, string>()
  const rememberWorktreeOwners = (): void => {
    for (const task of store.getTasks()) worktreeOwners.set(task.id, task.workspaceId)
  }
  rememberWorktreeOwners()
  const stopRememberingWorktreeOwners = store.subscribeActivity(rememberWorktreeOwners)
  const gitDelivery = new GitDeliveryManager((taskId) => {
    const legacyRoot = join(dataDirectory, 'worktrees')
    if (existsSync(join(legacyRoot, taskId))) return legacyRoot
    const task = store.getTask(taskId)
    const workspaceId = task?.workspaceId ?? worktreeOwners.get(taskId)
    if (!workspaceId) throw new Error('Task workspace not found')
    worktreeOwners.set(taskId, workspaceId)
    return join(store.getWorkspaceDirectory(workspaceId), 'worktrees')
  })
  const projectMemory = new WorkspaceProjectMemory(store, (workspaceId, settings) => createProjectMemory({
    dataDirectory: join(store.getWorkspaceDirectory(workspaceId), 'memory'),
    workspaceId,
    migrationsFolder: join(app.getAppPath(), 'src', 'main', 'memory', 'migrations'),
    settings
  }))

  const send: SendToRenderer = (channel, payload) => {
    getWindow()?.webContents.send(channel, payload)
  }
  const terminals = new TerminalManager({
    onData: (id, data, sequence) => broadcast('terminal:data', { id, data, sequence }),
    onExit: (id, code) => broadcast('terminal:exit', { id, code })
  })

  const context = { store, agentProcesses, gitDelivery, send }
  const taskEvents = registerTaskEvents(context)
  const taskMemory = createTaskMemory(context, projectMemory, (workspaceId) => projectMemory.forWorkspace(workspaceId))
  const finishTask = createTaskCompletion(context, taskEvents.recordSystemEvent, taskMemory)
  const execution = registerTaskExecution({ ...context, recordSystemEvent: taskEvents.recordSystemEvent }, finishTask)

  const wallpaperLibraries = new Map<string, WallpaperLibrary>()
  registerSettingsHandlers(ipc, store, (workspaceId) => {
    let library = wallpaperLibraries.get(workspaceId)
    if (!library) {
      library = new WallpaperLibrary(store.getWorkspaceDirectory(workspaceId))
      wallpaperLibraries.set(workspaceId, library)
    }
    return library
  }, (change) => {
    projectMemory.settingsChanged(change.workspaceId)
    broadcast('settings:changed', change)
  })
  registerWorkspaceHandlers(ipc, store, broadcast, async (workspaceId, name) => {
    const release = agentProcesses.acquireAccountChange(workspaceId)
    let resumeAccounts: (() => void) | undefined
    let resumeModels: (() => void) | undefined
    try {
      resumeAccounts = await accounts.pauseWorkspace(workspaceId)
      resumeModels = await pauseWorkspaceModelDiscovery(workspaceId)
      await agentProcesses.invalidateWorkspaceClients(workspaceId)
      await projectMemory.closeWorkspace(workspaceId)
      const polling = polls.get(workspaceId)
      polls.delete(workspaceId)
      await polling?.close()
      const workspace = store.renameWorkspace(workspaceId, name)
      wallpaperLibraries.delete(workspaceId)
      invalidateWorkspaceModels(workspaceId)
      return workspace
    } finally {
      resumeModels?.()
      resumeAccounts?.()
      release()
    }
  })
  registerAgentHandlers(ipc, store)
  const accounts = new WorkspaceAccounts(store, {
    acquire: (workspaceId) => agentProcesses.acquireAccountChange(workspaceId),
    busy: (workspaceId) => agentProcesses.isWorkspaceBusy(workspaceId),
    invalidate: async (workspaceId) => {
      await agentProcesses.invalidateWorkspaceClients(workspaceId)
      invalidateWorkspaceModels(workspaceId)
      broadcast('agents:models:changed', workspaceId)
    },
    openBrowser: openExternalCodexLogin,
    changed: (state) => broadcast('accounts:changed', state)
  })
  registerAccountHandlers(ipc, accounts)
  const stopAuthWatcher = watchWorkspaceAuthChanges(store, (workspaceId) => {
    invalidateWorkspaceModels(workspaceId)
    broadcast('agents:models:changed', workspaceId)
  })
  registerProjectHandlers(ipc, { store, gitDelivery, agentProcesses, stopTask: execution.stopTask, terminals, projectMemory, getWindow, projectsChanged: (workspaceId) => {
    if (workspaceId === store.getActiveWorkspace().id) broadcast('projects:changed', store.getProjects(workspaceId))
  } })
  registerTaskHandlers(ipc, {
    ...context,
    ...taskEvents,
    ...execution,
    promptWithProjectMemory: taskMemory.promptWithProjectMemory
  })
  const reviewContext = {
    ...context,
    ...execution,
    recordSystemEvent: taskEvents.recordSystemEvent,
    requireFinishedTask: execution.requireFinishedTask
  }
  registerSteeringHandlers(ipc, { ...context, ...taskEvents, resumeTask: execution.resumeTask })
  registerReviewHandlers(ipc, reviewContext)
  const credentials = (workspaceId: string): GitHubCredentials => new GitHubCredentials(join(store.getWorkspaceDirectory(workspaceId), 'github-token.enc'))
  const githubClient = new GitHubClient()
  const polls = new Map<string, GitHubPRPolling>()
  const workspacePolling = (workspaceId: string): GitHubPRPolling => {
    let polling = polls.get(workspaceId)
    if (!polling) {
      polling = new GitHubPRPolling({
        getPullRequestsToRefresh: () => store.getPullRequestsToRefresh(workspaceId),
        approveMergedPullRequest: (merge) => store.approveMergedPullRequest(merge, workspaceId)
      }, credentials(workspaceId), githubClient, (task, merge) => {
        taskEvents.recordSystemEvent(task.id, `GitHub merged ${merge.repository}#${merge.number} into ${merge.targetBranch}. Task approved.`)
        send('task:updated', task)
      }, (message) => console.warn(`GitHub PR refresh: ${message}`))
      polls.set(workspaceId, polling)
      polling.start()
    }
    return polling
  }
  const githubPolling = {
    refreshIfStale: (): void => {
      for (const workspace of store.getOpenedWorkspaces()) workspacePolling(workspace.id).refreshIfStale()
    },
    close: async (): Promise<void> => {
      stopPollingUpdates()
      await Promise.all([...polls.values()].map((polling) => polling.close()))
    }
  }
  const stopPollingUpdates = store.subscribeActivity(() => githubPolling.refreshIfStale())
  githubPolling.refreshIfStale()
  registerGitHubHandlers(ipc, {
    ...reviewContext, credentials, client: githubClient,
    refreshPullRequests: (workspaceId) => { void workspacePolling(workspaceId).refresh() },
    githubCredentialsChanged: (workspaceId) => { void workspacePolling(workspaceId).credentialsChanged() }
  })
  registerRebaseHandlers(ipc, reviewContext)
  registerTerminalHandlers(ipc, terminals, store)

  return {
    agentProcesses, closeAgentDiscovery: async () => { await accounts.close(); await closeModelDiscovery() }, terminals, githubPolling, stopCaffeineMode,
    closeStore: () => {
      stopAuthWatcher()
      stopRememberingWorktreeOwners()
      store.close()
    },
    ...(projectMemory ? { projectMemory } : {})
  }
}
