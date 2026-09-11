import { CONTEXT_COMPACTED } from '../../shared/task-context'
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
  const compacting = new Set<string>()
  agentProcesses.on('event', (event: TaskEvent) => {
    if (!store.getTask(event.taskId)) return
    send('task:event', store.appendEvent(event))
    if (event.category === 'system' && event.text === CONTEXT_COMPACTED) {
      const task = store.updateTask(event.taskId, { contextCompactionError: null })
      if (task) send('task:updated', { ...task, contextCompacting: compacting.has(event.taskId) })
    }
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
    send('task:event', store.appendEvent(event))
  }

  agentProcesses.on('session', (info: SessionInfo) => {
    const task = store.getTask(info.taskId)
    if (!task || task.sessionId === info.sessionId) return
    const updated = store.updateTask(info.taskId, { sessionId: info.sessionId, contextUsed: null, contextSize: null, contextCompactionError: null })
    if (updated) send('task:updated', updated)
  })

  agentProcesses.on('context', (info: { taskId: string; contextUsed: number | null; contextSize: number | null }) => {
    const task = store.updateTask(info.taskId, { contextUsed: info.contextUsed, contextSize: info.contextSize })
    if (task) send('task:updated', { ...task, contextCompacting: compacting.has(info.taskId) })
  })
  agentProcesses.on('compaction', (info: { taskId: string; running: boolean; error?: string | null }) => {
    if (info.running) compacting.add(info.taskId)
    else compacting.delete(info.taskId)
    const task = store.updateTask(info.taskId, { contextCompactionError: info.error ?? null })
    if (task) send('task:updated', { ...task, contextCompacting: info.running })
  })

  const usageBaselines = new Map<string, Pick<Task, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'totalTokens' | 'costUsd'>>()
  const forgetUsage = (taskId: string): void => { usageBaselines.delete(taskId) }
  agentProcesses.on('usage-boundary', forgetUsage)
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
    if (task) send('task:updated', { ...task, contextCompacting: compacting.has(taskId) })
  })

  return { recordSystemEvent, forgetUsage }
}
