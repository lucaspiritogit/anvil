import type { RendererIpc } from '../renderer-security'
import { withTaskOperation } from '../tasks/operations'
import { resumeTaskTurn } from '../tasks/resume'
import { getAgent } from '../agents/registry'
import { taskFollowupPrompt } from '../agents/task-prompts'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'
import type { Task } from '../../shared/types'
import { isTaskSettled } from '../../shared/task-settlement'

interface SteeringHandlerDependencies extends TaskContext {
  recordSystemEvent: RecordSystemEvent
  resumeTask: TaskExecution['resumeTask']
}

/** Live input stays in the active turn; stopped tasks resume their latest saved session. */
export function registerSteeringHandlers(ipc: RendererIpc, {
  store, agentProcesses, gitDelivery, send, recordSystemEvent, resumeTask
}: SteeringHandlerDependencies): void {
  const requireStoppedTask = (task: Task): void => {
    if (task.status === 'running' || agentProcesses.isRunning(task.id) ||
      ['preparing', 'finalizing', 'did_not_commit'].includes(task.deliveryStatus)) {
      throw new Error('This task has not finished stopping. Wait and try again.')
    }
  }
  ipc.handle('tasks:steer', async (_event, input): Promise<void> => {
    const { taskId } = input
    const message = input.message.trim()
    return withTaskOperation(store, taskId, 'steer', async (check) => {
      const task = store.getTask(taskId)
      if (!task) throw new Error('Task not found')
      const agent = getAgent(task.agentId)
      if (!agent) throw new Error('Agent not found')
      if (isTaskSettled(task)) throw new Error('This task is settled and cannot receive new instructions')
      if (task.status === 'running') {
        if (!agent.supportsSteering) throw new Error('This agent cannot accept input while running. Stop it before sending a follow-up.')
        if (!task.sessionId) throw new Error('This task does not have an agent session yet')
        if (!agentProcesses.isRunning(taskId)) throw new Error('The agent is between turns. Wait for output and try again.')
        // Never redirect a racing send into a different issue's session.
        await agentProcesses.steer({ taskId, sessionId: task.sessionId, message })
        recordSystemEvent(taskId, `You:\n${message}`)
        return
      }
      await resumeTaskTurn({ store, agentProcesses, gitDelivery, send }, {
        check,
        validate: (current) => {
          if (isTaskSettled(current)) throw new Error('This task is settled and cannot receive new instructions')
          requireStoppedTask(current)
        },
        resumeExecution: resumeTask,
        gitInstructions: false,
        prompt: (_current, state) => taskFollowupPrompt(state!, message)
      })
      recordSystemEvent(taskId, `You:\n${message}`)
    })
  })
}
