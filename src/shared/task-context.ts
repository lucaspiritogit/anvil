import type { Settings, Task } from './types'

export const CONTEXT_COMPACTED = 'Context compacted. Earlier model history was summarized; this log is unchanged.'

export function contextOccupancy(used: unknown, size: unknown): { contextUsed: number | null; contextSize: number | null } {
  return {
    contextUsed: typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : null,
    contextSize: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : null
  }
}

export function shouldCompactContext(task: Pick<Task, 'sessionId' | 'contextUsed' | 'contextSize'>, settings: Pick<Settings, 'autoCompactContext' | 'contextCompactionThreshold'>): boolean {
  const { contextUsed, contextSize } = contextOccupancy(task.contextUsed, task.contextSize)
  return Boolean(task.sessionId && settings.autoCompactContext !== false && contextUsed !== null && contextSize !== null &&
    contextUsed / contextSize * 100 >= (settings.contextCompactionThreshold ?? 75))
}
