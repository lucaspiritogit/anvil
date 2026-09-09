import { WallpaperLibrary } from './wallpapers'
import { app, BrowserWindow, powerSaveBlocker } from 'electron'
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
  githubPolling: GitHubPRPolling
  stopCaffeineMode(): void
  closeStore(): void
} {
  const ipc = createRendererIpc(getWindow, rendererUrl)
  const broadcast = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }
  // Migrations ship under the app root in development and packaged builds.
  const store = new Store(join(dataDirectory, 'anvil.db'), {
    migrationsFolder: join(app.getAppPath(), 'src', 'main', 'db', 'migrations')
  })
  const agentProcesses = new AgentProcessManager()
  const stopCaffeineMode = registerCaffeineMode(store, powerSaveBlocker)
  const gitDelivery = new GitDeliveryManager(join(dataDirectory, 'worktrees'))
  const projectMemory = new WorkspaceProjectMemory(store, (workspaceId, settings) => createProjectMemory({
    dataDirectory: workspaceId === 'default' ? join(dataDirectory, 'memory') : join(store.getWorkspaceDirectory(workspaceId), 'memory'),
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

  registerSettingsHandlers(ipc, store, new WallpaperLibrary(dataDirectory), (change) => {
    projectMemory.settingsChanged(change.workspaceId)
    broadcast('settings:changed', change)
  })
  registerWorkspaceHandlers(ipc, store, broadcast)
  registerAgentHandlers(ipc)
  registerProjectHandlers(ipc, { store, gitDelivery, agentProcesses, stopTask: execution.stopTask, terminals, projectMemory, getWindow, projectsChanged: () => broadcast('projects:changed', store.getProjects()) })
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
  const credentials = new GitHubCredentials(join(dataDirectory, 'github-token.enc'))
  const githubClient = new GitHubClient()
  const githubPolling = new GitHubPRPolling(store, credentials, githubClient, (task, merge) => {
    taskEvents.recordSystemEvent(task.id, `GitHub merged ${merge.repository}#${merge.number} into ${merge.targetBranch}. Task approved.`)
    send('task:updated', task)
  }, (message) => console.warn(`GitHub PR refresh: ${message}`))
  githubPolling.start()
  registerGitHubHandlers(ipc, {
    ...reviewContext, credentials, client: githubClient,
    refreshPullRequests: () => { void githubPolling.refresh() },
    githubCredentialsChanged: () => { void githubPolling.credentialsChanged() }
  })
  registerRebaseHandlers(ipc, reviewContext)
  registerTerminalHandlers(ipc, terminals, store)

  return { agentProcesses, terminals, githubPolling, stopCaffeineMode, closeStore: () => store.close(), ...(projectMemory ? { projectMemory } : {}) }
}
