import { ipcMain } from 'electron'
import { getAgent } from '../agents/registry'
import { agentRebasePrompt } from '../agents/task-prompts'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import type { IssueExecution } from '../tasks/issue-execution'
import type { RebaseStep } from '../../shared/types'

interface RebaseHandlerDependencies extends TaskContext {
  recordSystemEvent: RecordSystemEvent
  requireFinishedTracker: IssueExecution['requireFinishedTracker']
}

export function registerRebaseHandlers({
  store, agentProcesses, gitDelivery, send, recordSystemEvent, requireFinishedTracker
}: RebaseHandlerDependencies): void {
  // Manual rebase does not start an agent or change the task to running.
  ipcMain.handle('tasks:rebase', async (_event, input: { taskId: string; steps: RebaseStep[] }) => {
    requireFinishedTracker(input.taskId)
    const task = store.getTask(input.taskId)
    if (!task) throw new Error('Task not found')
    if (agentProcesses.isRunning(input.taskId)) throw new Error('This task is already running')
    if (!task.branchName || !task.baseCommit) throw new Error('This task has no branch to rebase')

    const project = store.getProjects().find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')

    const result = await gitDelivery.rebase(
      project.path,
      input.taskId,
      task.branchName,
      task.baseCommit,
      input.steps
    )

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
  })

  ipcMain.handle('tasks:rebase-agent', async (_event, taskId: string) => {
    requireFinishedTracker(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (agentProcesses.isRunning(taskId)) throw new Error('This task is already running')
    if (!task.branchName || !task.baseCommit) throw new Error('This task has no branch to rebase')

    const project = store.getProjects().find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')

    const agent = getAgent(task.agentId)
    if (!agent) throw new Error(`Unknown agent: ${task.agentId}`)

    const reopened = await gitDelivery.reopen(project.path, taskId, task.branchName)
    if (!store.getTask(taskId)) throw new Error('Task was deleted')
    const running = store.updateTask(taskId, {
      status: 'running',
      cwd: reopened.cwd,
      endedAt: undefined,
      exitCode: null,
      error: undefined,
      deliveryStatus: 'working',
      worktreePath: reopened.worktreePath,
      deliveryError: undefined
    })!
    send('task:updated', running)

    const resumeSessionId = task.sessionId

    setImmediate(() => {
      if (store.getTask(taskId)?.status !== 'running') return
      agentProcesses.start({
        taskId,
        agent,
        prompt: agentRebasePrompt(task.baseCommit!),
        model: task.model,
        cwd: reopened.cwd,
        ...(resumeSessionId ? { resumeSessionId } : {})
      })
    })
    return running
  })
}
