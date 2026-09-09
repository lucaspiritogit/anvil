import type { RendererIpc } from '../renderer-security'
import { withTaskOperation } from '../tasks/operations'
import { resumeTaskTurn } from '../tasks/resume'
import { agentRebasePrompt } from '../agents/task-prompts'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'

interface RebaseHandlerDependencies extends TaskContext {
  recordSystemEvent: RecordSystemEvent
  requireFinishedTask: TaskExecution['requireFinishedTask']
}

export function registerRebaseHandlers(ipc: RendererIpc, {
  store, agentProcesses, gitDelivery, send, recordSystemEvent, requireFinishedTask
}: RebaseHandlerDependencies): void {
  // Manual rebase does not start an agent or change the task to running.
  ipc.handle('tasks:rebase', async (_event, input) => withTaskOperation(store, input.taskId, 'rebase', async (check) => {
    requireFinishedTask(input.taskId)
    const task = store.getTask(input.taskId)
    if (!task) throw new Error('Task not found')
    if (task.settledAt !== undefined) throw new Error('This task is settled and cannot be rebased')
    if (agentProcesses.isRunning(input.taskId)) throw new Error('This task is already running')
    if (!task.branchName || !task.baseCommit) throw new Error('This task has no branch to rebase')

    const project = store.getProjects().find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')

    const result = await gitDelivery.rebase(
      project.path,
      input.taskId,
      task.branchName,
      task.baseCommit,
      input.steps,
      () => {
        check()
        requireFinishedTask(input.taskId)
      }
    )

    check()
    requireFinishedTask(input.taskId)
    const kept = input.steps.filter((step) => step.action !== 'drop').length
    const dropped = input.steps.length - kept
    recordSystemEvent(
      input.taskId,
      `Rebased ${input.steps.length} commits into ${result.commits.length}` +
      (dropped ? `, dropping ${dropped}.` : '.')
    )

    const updated = store.updateTask(input.taskId, {
      headCommit: result.headCommit,
      filesChanged: result.filesChanged,
      additions: result.additions,
      deletions: result.deletions,
      // A rebase that drops every change leaves nothing to review.
      deliveryStatus: result.filesChanged > 0 ? task.deliveryStatus : 'no_changes'
    })!
    if (!updated) throw new Error('Task was deleted')
    send('task:updated', updated)
    return updated
  }))

  ipc.handle('tasks:rebase-agent', async (_event, taskId: string) => {
    return withTaskOperation(store, taskId, 'rebase', (check) => resumeTaskTurn(
      { store, agentProcesses, gitDelivery, send }, {
        check,
        gitInstructions: false,
        validate: (task) => {
          requireFinishedTask(taskId)
          if (!task.branchName || !task.baseCommit) throw new Error('This task has no branch to rebase')
        },
        prompt: (task) => agentRebasePrompt(task.baseCommit!)
      }
    ))
  })
}
