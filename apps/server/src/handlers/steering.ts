import { randomUUID } from 'node:crypto'
import type { HandlerRegistry } from '../handler-registry'
import { taskOperationActive, taskOperationKind, withTaskOperation } from '../tasks/operations'
import { resumeTaskTurn } from '../tasks/resume'
import { getAgent } from '../agents/registry'
import { taskFollowupPrompt, withDiffNotes } from '../agents/task-prompts'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'
import type { Task, TaskQueuedPrompt } from '@anvil/protocol/types'
import { isTaskSettled } from '@anvil/protocol/task-settlement'

interface SteeringHandlerDependencies extends TaskContext {
  recordSystemEvent: RecordSystemEvent
  resumeTask: TaskExecution['resumeTask']
  acceptTaskResume: TaskExecution['acceptTaskResume']
  rollbackTaskResume: TaskExecution['rollbackTaskResume']
  turnStopped: TaskExecution['turnStopped']
  onTurnSettled: TaskExecution['onTurnSettled']
}

export const STEER_FALLBACK_NOTICE = "Couldn't add your message to the current turn, so it's queued for after it."

const STOPPING_DELIVERY = ['preparing', 'finalizing', 'did_not_commit']

/**
 * Live input stays in the active turn; stopped tasks resume their latest saved session.
 * Messages that cannot join the active turn wait in a per-task queue. Each time a task's
 * run settles, the next queued message resumes it as a follow-up, so in multi-issue
 * plans queued messages are delivered once the whole run stops rather than between issues.
 */
export function registerSteeringHandlers(ipc: HandlerRegistry, {
  store, agentProcesses, gitDelivery, send, recordSystemEvent, resumeTask, acceptTaskResume, rollbackTaskResume,
  turnStopped, onTurnSettled
}: SteeringHandlerDependencies): void {
  const requireStoppedTask = (task: Task): void => {
    if (task.status === 'running' || agentProcesses.isRunning(task.id) || STOPPING_DELIVERY.includes(task.deliveryStatus)) {
      throw new Error('This task has not finished stopping. Wait and try again.')
    }
  }
  const requireOpenTask = (taskId: string): Task => {
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (!getAgent(task.agentId)) throw new Error('Agent not found')
    if (isTaskSettled(task)) throw new Error('This task is archived and cannot receive new instructions')
    return task
  }
  const queueOf = (taskId: string): TaskQueuedPrompt[] => store.getTask(taskId)?.promptQueue ?? []
  const saveQueue = (taskId: string, promptQueue: TaskQueuedPrompt[]): void => {
    const task = store.updateTask(taskId, { promptQueue })
    if (task) send('task:updated', task)
  }
  const enqueue = (taskId: string, message: string, notice?: string): void => {
    saveQueue(taskId, [...queueOf(taskId), { id: randomUUID(), message, queuedAt: Date.now() }])
    if (notice) recordSystemEvent(taskId, notice)
  }
  const withNotes = (taskId: string, typed: string): { message: string; markNotesSent: () => void } => {
    const notes = store.getComments(taskId).filter((comment) => comment.sentAt === null)
    return {
      message: withDiffNotes(typed, notes),
      markNotesSent: () => {
        if (notes.length) store.markCommentsSent(taskId, Date.now(), notes.map((comment) => comment.id))
      }
    }
  }

  const steerLive = async (task: Task, typed: string): Promise<void> => {
    if (!getAgent(task.agentId)?.supportsSteering) throw new Error('This agent cannot accept input while running.')
    if (!task.sessionId) throw new Error('This task does not have an agent session yet')
    if (!agentProcesses.isRunning(task.id)) throw new Error('The agent is between turns.')
    const { message, markNotesSent } = withNotes(task.id, typed)
    // Never redirect a racing send into a different issue's session.
    await agentProcesses.steer({ taskId: task.id, sessionId: task.sessionId, message })
    markNotesSent()
    recordSystemEvent(task.id, `You (steered):\n${message}`)
  }

  const resume = async (taskId: string, typed: string, check: (expected?: Task) => Task, label = 'You'): Promise<void> => {
    const { message, markNotesSent } = withNotes(taskId, typed)
    await resumeTaskTurn({ store, agentProcesses, gitDelivery, send }, {
      check,
      validate: (current) => {
        if (isTaskSettled(current)) throw new Error('This task is archived and cannot receive new instructions')
        requireStoppedTask(current)
      },
      resumeExecution: resumeTask,
      acceptExecution: acceptTaskResume,
      rollbackExecution: rollbackTaskResume,
      gitInstructions: false,
      prompt: (_current, state) => taskFollowupPrompt(state!, message)
    })
    markNotesSent()
    recordSystemEvent(taskId, `${label}:\n${message}`)
  }

  const canDrain = (task: Task): boolean =>
    !isTaskSettled(task) && task.status !== 'running' && task.status !== 'cancelled' &&
    !STOPPING_DELIVERY.includes(task.deliveryStatus) && turnStopped(task.id) && !taskOperationActive(store, task.id)

  const drain = async (taskId: string): Promise<void> => {
    const task = store.getTask(taskId)
    const [next, ...rest] = task?.promptQueue ?? []
    if (!task || !next || !canDrain(task)) return
    saveQueue(taskId, rest)
    try {
      await withTaskOperation(store, taskId, 'steer', (check) => resume(taskId, next.message, check, 'You (from queue)'))
    } catch (error) {
      if (!store.getTask(taskId)) return
      saveQueue(taskId, [next, ...queueOf(taskId)])
      recordSystemEvent(taskId, `Couldn't send your queued message: ${error instanceof Error ? error.message : String(error)}`, 'delivery', 'error')
    }
  }
  const scheduleDrain = (taskId: string): void => {
    setImmediate(() => { drain(taskId).catch((error) => console.warn('Could not drain queued messages:', error)) })
  }
  onTurnSettled(scheduleDrain)

  ipc.handle('tasks:steer', async (input): Promise<void> => {
    const { taskId, mode = 'steer' } = input
    const typed = input.message.trim()
    const task = requireOpenTask(taskId)
    if (task.status === 'running' || taskOperationKind(store, taskId) === 'steer') {
      if (mode === 'queue') {
        enqueue(taskId, typed, `Queued for after this turn:\n${typed}`)
        return
      }
      try {
        await withTaskOperation(store, taskId, 'steer', async (check) => steerLive(check(), typed))
      } catch {
        if (!store.getTask(taskId)) throw new Error('Task was deleted')
        enqueue(taskId, typed, STEER_FALLBACK_NOTICE)
      }
      return
    }
    try {
      await withTaskOperation(store, taskId, 'steer', (check) => resume(taskId, typed, check))
    } finally {
      if (queueOf(taskId).length) scheduleDrain(taskId)
    }
  })

  ipc.handle('tasks:queue:remove', ({ taskId, id }): void => {
    if (!store.getTask(taskId)) throw new Error('Task not found')
    const queue = queueOf(taskId)
    if (queue.some((item) => item.id === id)) saveQueue(taskId, queue.filter((item) => item.id !== id))
  })

  ipc.handle('tasks:queue:edit', ({ taskId, id, message }): void => {
    if (!store.getTask(taskId)) throw new Error('Task not found')
    const queue = queueOf(taskId)
    if (!queue.some((item) => item.id === id)) throw new Error('This queued message was already sent or removed')
    saveQueue(taskId, queue.map((item) => item.id === id ? { ...item, message: message.trim() } : item))
  })

  ipc.handle('tasks:queue:steer', async ({ taskId, id }): Promise<void> => {
    const task = requireOpenTask(taskId)
    const queue = queueOf(taskId)
    const index = queue.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('This queued message was already sent or removed')
    const item = queue[index]
    saveQueue(taskId, queue.filter((entry) => entry.id !== id))
    try {
      await withTaskOperation(store, taskId, 'steer', (check) => task.status === 'running'
        ? steerLive(check(), item.message)
        : resume(taskId, item.message, check, 'You (from queue)'))
    } catch (error) {
      if (store.getTask(taskId)) {
        const current = queueOf(taskId)
        saveQueue(taskId, [...current.slice(0, index), item, ...current.slice(index)])
      }
      throw error
    }
  })
}
