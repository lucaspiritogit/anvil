import { createCaffeineActivity } from './caffeine-activity'
import { EventEmitter } from 'node:events'
import { createHandlerRegistry, type HandlerContext } from './handler-registry'
import { createCredentialEncryption } from './credential-encryption'
import { TerminalSessionManager } from './terminal-sessions'
import { WorkspaceAccounts } from './agents/workspace-accounts'
import { registerAccountHandlers } from './handlers/agent-accounts'
import { invalidateWorkspaceModels, closeModelDiscovery, pauseWorkspaceModelDiscovery } from './agents/models'
import { watchWorkspaceAuthChanges } from './agents/workspace-auth-changes'
import { resolveTaskWorkspace } from './agents/workspace-execution'
import { WallpaperLibrary } from './wallpapers'
import { join } from 'node:path'
import { AgentProcessManager } from './agents/process-manager'
import { GitDeliveryManager } from './git'
import { registerAgentHandlers } from './handlers/agents'
import { registerGitHubHandlers } from './handlers/github'
import { GitHubCredentials, type CredentialEncryption } from './github-credentials'
import { GitHubPRPolling } from './github-pr-polling'
import { GitHubClient } from './github-client'
import { registerProjectHandlers } from './handlers/projects'
import { registerRebaseHandlers } from './handlers/rebase'
import { registerReviewHandlers } from './handlers/review'
import { registerTaskHandlers } from './handlers/tasks'
import { registerSteeringHandlers } from './handlers/steering'
import { registerWorkspaceHandlers } from './handlers/workspaces'
import { registerConnectionsHandlers, registerSettingsHandlers } from './handlers/settings'
import { ServerAuth } from './server-auth'
import { createProjectMemory } from './memory/project-memory'
import { WorkspaceProjectMemory } from './memory/workspace-project-memory'
import { createTaskMemory } from './memory/task-memory'
import { createTaskCompletion } from './tasks/completion'
import type { PublishEvent } from './tasks/context'
import { registerTaskEvents } from './tasks/events'
import { registerTaskExecution } from './tasks/task-execution'
import { Store } from './store'
import type { TailscaleConnection } from './tailscale'
import { TaskBranches } from './tasks/task-branch'
import type { HeadlessAccessMode } from '../shared/types'
import { IssueToolServer } from './issue-tools/server'

export interface RuntimeOptions {
  dataDirectory: string
  migrationsDirectory: string
  memoryMigrationsDirectory: string
  encryption?: CredentialEncryption
  openUrl?(url: string): Promise<void>
  rebindHttp?(allowOtherDevices: boolean): Promise<void>
  serverAuth?: ServerAuth
  tailscale?: TailscaleConnection
  headlessAccess?: HeadlessAccessMode
}

/** Owns the domain services independently of Electron and HTTP. */
export function createAnvilRuntime(options: RuntimeOptions) {
  const { dataDirectory } = options
  const ipc = createHandlerRegistry()
  const events = new EventEmitter()
  events.setMaxListeners(0)
  const broadcast = (channel: string, payload: unknown): void => {
    events.emit('event', channel, payload)
  }
  const encryption = options.encryption ?? createCredentialEncryption(join(dataDirectory, 'credentials.key'))
  const store = new Store(join(dataDirectory, 'config.json'), {
    migrationsFolder: options.migrationsDirectory
  })
  const caffeineActivity = createCaffeineActivity(store)
  ipc.handle('app:caffeine', () => caffeineActivity.snapshot())
  const stopCaffeineActivity = caffeineActivity.subscribe((state) => broadcast('app:caffeine', state))
  const terminals = new TerminalSessionManager(store, broadcast)
  ipc.handle('terminals:create', (input) => terminals.createProject(input))
  ipc.handle('terminals:attach', (id) => terminals.attach(id))
  ipc.handle('terminals:dispose', (id) => terminals.dispose(id))
  ipc.on('terminals:write', (input) => terminals.write(input.sessionId, input.data))
  ipc.on('terminals:resize', (input) => terminals.resize(input.sessionId, input.cols, input.rows))
  const issueTools = new IssueToolServer(store, (taskId) => {
    const task = store.getTask(taskId)
    if (task) broadcast('task:updated', task)
  }, { set: (...args) => taskBranches.set(...args) })
  const agentProcesses = new AgentProcessManager(undefined, undefined, undefined,
    (taskId) => resolveTaskWorkspace(store, taskId), (taskId) => issueTools.open(taskId))
  const worktreeOwners = new Map<string, string>()
  const rememberWorktreeOwners = (): void => {
    for (const task of store.getTasks()) worktreeOwners.set(task.id, task.workspaceId)
  }
  rememberWorktreeOwners()
  const stopRememberingWorktreeOwners = store.subscribeActivity(rememberWorktreeOwners)
  const gitDelivery = new GitDeliveryManager((taskId) => {
    const task = store.getTask(taskId)
    const workspaceId = task?.workspaceId ?? worktreeOwners.get(taskId)
    if (!workspaceId) throw new Error('Task workspace not found')
    worktreeOwners.set(taskId, workspaceId)
    return join(store.getWorkspaceDirectory(workspaceId), 'worktrees')
  })
  const taskBranches = new TaskBranches({ store, gitDelivery, send: broadcast })
  const projectMemory = new WorkspaceProjectMemory(store, (workspaceId, settings) => createProjectMemory({
    dataDirectory: join(store.getWorkspaceDirectory(workspaceId), 'memory'),
    workspaceId,
    migrationsFolder: options.memoryMigrationsDirectory,
    settings
  }))

  const send: PublishEvent = broadcast
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
  const connections = registerConnectionsHandlers(
    ipc,
    store,
    options.serverAuth ?? new ServerAuth(dataDirectory),
    options.rebindHttp ?? (async () => {}),
    (workspaceId, status) => broadcast('connections:changed', { workspaceId, status }),
    options.tailscale,
    options.headlessAccess
  )
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
  }, () => terminals.disposeProjects(), (workspaceId, handlerContext) => {
    handlerContext.deferUntilResponse(async () => { await connections.activate(workspaceId) })
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
    terminals,
    openBrowser: options.openUrl ?? (async (url) => { broadcast('open-url', url) }),
    changed: (state) => broadcast('accounts:changed', state)
  })
  registerAccountHandlers(ipc, accounts)
  const stopAuthWatcher = watchWorkspaceAuthChanges(store, (workspaceId) => {
    invalidateWorkspaceModels(workspaceId)
    broadcast('agents:models:changed', workspaceId)
  })
  registerProjectHandlers(ipc, { store, gitDelivery, agentProcesses, stopTask: execution.stopTask, projectMemory, projectsChanged: (workspaceId) => {
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
  registerSteeringHandlers(ipc, { ...context, ...taskEvents, ...execution })
  registerReviewHandlers(ipc, reviewContext)
  const credentials = (workspaceId: string): GitHubCredentials => new GitHubCredentials(join(store.getWorkspaceDirectory(workspaceId), 'github-token.enc'), encryption)
  const githubClient = new GitHubClient()
  const polls = new Map<string, GitHubPRPolling>()
  const workspacePolling = (workspaceId: string): GitHubPRPolling => {
    let polling = polls.get(workspaceId)
    if (!polling) {
      polling = new GitHubPRPolling({
        getPullRequestsToRefresh: () => store.getPullRequestsToRefresh(workspaceId),
        approveMergedPullRequest: (merge) => store.approveMergedPullRequest(merge, workspaceId)
      }, credentials(workspaceId), githubClient, (task, merge) => {
        taskEvents.recordSystemEvent(task.id, `GitHub merged ${merge.repository}#${merge.number} into ${merge.targetBranch}. Task merged.`)
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

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      stopCaffeineActivity()
      stopAuthWatcher()
      stopPollingUpdates()
      stopRememberingWorktreeOwners()
      const results = await Promise.allSettled([
        connections.close(),
        Promise.resolve().then(() => terminals.disposeAll()),
        Promise.resolve().then(() => agentProcesses.close()),
        Promise.resolve().then(() => accounts.close()),
        Promise.resolve().then(() => closeModelDiscovery()),
        Promise.resolve().then(() => issueTools.close()),
        Promise.resolve().then(() => githubPolling.close()),
        Promise.resolve().then(() => projectMemory.close())
      ])
      store.close()
      events.removeAllListeners()
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Could not close Anvil runtime')
    })()
    return closing
  }

  return {
    invoke: (channel: string, input?: unknown, context?: HandlerContext): unknown => {
      if (closing) throw new Error('Anvil runtime is closing')
      return ipc.invoke(channel, input, context)
    },
    channels: ipc.channels,
    subscribe(channel: string, listener: (payload: unknown) => void): () => void {
      const receive = (name: string, payload: unknown): void => { if (name === channel) listener(payload) }
      events.on('event', receive)
      return () => { events.off('event', receive) }
    },
    subscribeAll(listener: (channel: string, payload: unknown) => void): () => void {
      events.on('event', listener)
      return () => { events.off('event', listener) }
    },
    close,
    initializeConnections: connections.initialize,
    connectionsStatus: connections.status,
    terminals,
    agentProcesses,
    projectMemory
  }
}
