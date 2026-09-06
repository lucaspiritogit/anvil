import { randomUUID } from 'node:crypto'
import type { ExitInfo, SessionInfo, UsageInfo } from '../agents/process-manager'
import type { Task, TaskEvent } from '../../shared/types'
import type { RecordSystemEvent, TaskContext } from './context'

export interface TaskEvents {
  recordSystemEvent: RecordSystemEvent
  forgetUsage(taskId: string): void
}

/** Persists agent output, sessions, and per-process usage, then notifies the renderer. */
export function registerTaskEvents({ store, agentProcesses, send }: Pick<TaskContext, 'store' | 'agentProcesses' | 'send'>): TaskEvents {
  agentProcesses.on('event', (event: TaskEvent) => {
    if (!store.getTask(event.taskId)) return
    store.appendEvent(event)
    send('task:event', event)
  })

  const recordSystemEvent: RecordSystemEvent = (taskId, text, kind = 'delivery', category = 'system') => {
    if (!store.getTask(taskId)) return
    const event: TaskEvent = {
      id: randomUUID(),
      taskId,
      ts: Date.now(),
      stream: 'system',
      kind,
      category,
      text
    }
    store.appendEvent(event)
    send('task:event', event)
  }

  agentProcesses.on('session', (info: SessionInfo) => {
    const task = store.getTask(info.taskId)
    if (!task || task.sessionId === info.sessionId) return
    const updated = store.updateTask(info.taskId, { sessionId: info.sessionId })
    if (updated) send('task:updated', updated)
  })

  const usageBaselines = new Map<string, Pick<Task, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'totalTokens' | 'costUsd'>>()
  const forgetUsage = (taskId: string): void => { usageBaselines.delete(taskId) }
  agentProcesses.on('exit', (info: ExitInfo) => { forgetUsage(info.taskId) })
  agentProcesses.on('usage', (info: UsageInfo) => {
    const { taskId, ...usage } = info
    const current = store.getTask(taskId)
    if (!current) return
    const baseline = usageBaselines.get(taskId) ?? current
    usageBaselines.set(taskId, baseline)
    const task = store.updateTask(taskId, {
      inputTokens: baseline.inputTokens + usage.inputTokens,
      outputTokens: baseline.outputTokens + usage.outputTokens,
      cachedTokens: baseline.cachedTokens + usage.cachedTokens,
      totalTokens: baseline.totalTokens + usage.totalTokens,
      costUsd: usage.costUsd === null ? baseline.costUsd : (baseline.costUsd ?? 0) + usage.costUsd
    })
    if (task) send('task:updated', task)
  })

  return { recordSystemEvent, forgetUsage }
}
