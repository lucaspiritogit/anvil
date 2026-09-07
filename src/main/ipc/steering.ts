import { ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { GIT_SYSTEM_PROMPT, getAgent } from '../agents/registry'
import { taskFollowupPrompt } from '../agents/task-prompts'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'
import type { Task } from '../../shared/types'

interface SteeringHandlerDependencies extends TaskContext {
  recordSystemEvent: RecordSystemEvent
  resumeTask: TaskExecution['resumeTask']
}

/** Live input stays in the active turn; stopped tasks resume their latest saved session. */
export function registerSteeringHandlers({
  store, agentProcesses, gitDelivery, send, recordSystemEvent, resumeTask
}: SteeringHandlerDependencies): void {
  const sending = new Set<string>()
  const requireStoppedTask = (task: Task): void => {
    if (task.status === 'running' || agentProcesses.isRunning(task.id) ||
      ['preparing', 'finalizing', 'did_not_commit'].includes(task.deliveryStatus)) {
      throw new Error('This task has not finished stopping. Wait and try again.')
    }
  }
  ipcMain.handle('tasks:steer', async (_event, input: { taskId: string; message: string }): Promise<void> => {
    if (!input || typeof input.taskId !== 'string' || !input.taskId.trim()) throw new Error('A task ID is required')
    if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('A message needs some text')
    const { taskId } = input
    const message = input.message.trim()
    if (sending.has(taskId)) throw new Error('A message is already being sent to this task')
    sending.add(taskId)
    try {
      const task = store.getTask(taskId)
      if (!task) throw new Error('Task not found')
      const agent = getAgent(task.agentId)
      if (!agent) throw new Error('Agent not found')
      if (task.status === 'running') {
        if (!agent.supportsSteering) throw new Error('This agent cannot accept input while running. Stop it before sending a follow-up.')
        if (!task.sessionId) throw new Error('This task does not have an agent session yet')
        if (!agentProcesses.isRunning(taskId)) throw new Error('The agent is between turns. Wait for output and try again.')
        // Never redirect a racing send into a different issue's session.
        await agentProcesses.steer({ taskId, sessionId: task.sessionId, message })
        recordSystemEvent(taskId, `You:\n${message}`)
        return
      }
      requireStoppedTask(task)
      if (task.sessionId && !agent.executionProtocol && !agent.resumeArgs) {
        throw new Error('This agent cannot resume its saved session')
      }
      const project = store.getProjects().find((entry) => entry.id === task.projectId)
      if (!project) throw new Error('Project not found')
      let location: Partial<Task> = { cwd: task.cwd, worktreePath: undefined }
      if (task.worktreePath && existsSync(task.worktreePath)) {
        location = { cwd: task.cwd, worktreePath: task.worktreePath }
      } else if (task.branchName) {
        const reopened = await gitDelivery.reopen(project.path, taskId, task.branchName)
        // Keep the original diff baseline; reopen reports the branch's current HEAD.
        location = { cwd: reopened.cwd, worktreePath: reopened.worktreePath }
      } else if (task.deliveryStatus !== 'unavailable' && (await gitDelivery.status(project.path)).isRepository) {
        // Retrying failed preparation still needs its own worktree, never the source checkout.
        const prepared = await gitDelivery.prepare(project.path, taskId, task.title)
        location = {
          cwd: prepared.cwd, worktreePath: prepared.worktreePath, baseCommit: prepared.baseCommit,
          baseBranch: prepared.baseBranch, branchName: prepared.branchName
        }
      }

      // Reopening can race deletion or another follow-up. Re-read the session
      // immediately before starting and let the execution module reserve recovery.
      const current = store.getTask(taskId)
      if (!current) throw new Error('Task was deleted')
      requireStoppedTask(current)
      const previousState = store.getTaskExecution(taskId)
      const state = resumeTask(taskId)
      const prompt = taskFollowupPrompt(current, state, message)
      const running = store.updateTask(taskId, {
        ...location, status: 'running', endedAt: undefined, exitCode: null, error: undefined,
        deliveryStatus: location.worktreePath ? 'working' : 'unavailable', deliveryError: undefined
      })!
      send('task:updated', running)
      try {
        agentProcesses.start({
          taskId, issueId: state.currentIssueId ?? undefined, agent, cwd: running.cwd, projectPath: project.path,
          model: current.model, thinkingLevel: state.thinkingLevel, modelEffort: state.modelEffort,
          resumeSessionId: current.sessionId,
          prompt: location.worktreePath ? `${GIT_SYSTEM_PROMPT}\n\n${prompt}` : prompt
        })
      } catch (error) {
        const restored = store.updateTask(taskId, current)
        if (restored && previousState) store.saveTaskExecution(previousState)
        if (restored) send('task:updated', restored)
        throw error
      }
      recordSystemEvent(taskId, `You:\n${message}`)
    } finally {
      sending.delete(taskId)
    }
  })
}
