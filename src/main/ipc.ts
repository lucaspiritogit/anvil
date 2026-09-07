import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { AgentProcessManager } from './agents/process-manager'
import { GitDeliveryManager } from './git-delivery'
import { registerAgentHandlers } from './ipc/agents'
import { registerProjectHandlers } from './ipc/projects'
import { registerRebaseHandlers } from './ipc/rebase'
import { registerReviewHandlers } from './ipc/review'
import { registerTaskHandlers } from './ipc/tasks'
import { registerSteeringHandlers } from './ipc/steering'
import { registerSettingsHandlers } from './ipc/settings'
import { registerTerminalHandlers } from './ipc/terminals'
import { createProjectMemory, type ProjectMemory } from './memory/project-memory'
import { createTaskMemory } from './memory/task-memory'
import { createTaskCompletion } from './tasks/completion'
import type { SendToRenderer } from './tasks/context'
import { registerTaskEvents } from './tasks/events'
import { registerTaskExecution } from './tasks/task-execution'
import { Store } from './store'
import { TerminalManager } from './terminal'

/** Creates main-process dependencies and registers their IPC handlers. */
export function registerIpc(getWindow: () => BrowserWindow | null): {
  agentProcesses: AgentProcessManager
  terminals: TerminalManager
  projectMemory?: ProjectMemory
} {
  const dataDirectory = join(app.getPath('home'), '.anvil-composer')
  // Migrations ship under the app root in development and packaged builds.
  const store = new Store(join(dataDirectory, 'anvil.db'), {
    migrationsFolder: join(app.getAppPath(), 'src', 'main', 'db', 'migrations')
  })
  const agentProcesses = new AgentProcessManager()
  const gitDelivery = new GitDeliveryManager(join(dataDirectory, 'worktrees'))
  const projectMemory = createProjectMemory({
    dataDirectory: join(dataDirectory, 'memory'),
    migrationsFolder: join(app.getAppPath(), 'src', 'main', 'memory', 'migrations')
  })
  if (projectMemory) {
    void projectMemory
      .connect()
      .then(() => console.info('Project memory is ready.'))
      .catch((error) => console.warn('Project memory is unavailable:', error))
  }

  const send: SendToRenderer = (channel, payload) => {
    getWindow()?.webContents.send(channel, payload)
  }
  const terminals = new TerminalManager({
    onData: (id, data) => send('terminal:data', { id, data }),
    onExit: (id, code) => send('terminal:exit', { id, code })
  })

  const context = { store, agentProcesses, gitDelivery, send }
  const taskEvents = registerTaskEvents(context)
  const taskMemory = createTaskMemory(context, projectMemory)
  const finishTask = createTaskCompletion(context, taskEvents.recordSystemEvent, taskMemory)
  const execution = registerTaskExecution(context, finishTask)

  registerSettingsHandlers(store)
  registerAgentHandlers()
  registerProjectHandlers({ store, gitDelivery, agentProcesses, stopTask: execution.stopTask, terminals, projectMemory, getWindow })
  registerTaskHandlers({
    ...context,
    ...taskEvents,
    ...execution,
    promptWithProjectMemory: taskMemory.promptWithProjectMemory
  })
  const reviewContext = {
    ...context,
    recordSystemEvent: taskEvents.recordSystemEvent,
    requireFinishedTask: execution.requireFinishedTask
  }
  registerSteeringHandlers({ ...context, ...taskEvents, resumeTask: execution.resumeTask })
  registerReviewHandlers(reviewContext)
  registerRebaseHandlers(reviewContext)
  registerTerminalHandlers(terminals)

  return { agentProcesses, terminals, ...(projectMemory ? { projectMemory } : {}) }
}
