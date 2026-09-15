export const THINKING_LEVELS = ['fast', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ThinkingLevel = typeof THINKING_LEVELS[number]

const LEVEL_ALIASES: Readonly<Record<string, ThinkingLevel>> = {
  minimal: 'fast',
  fast: 'fast',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max'
}

export function thinkingLevel(value: string): ThinkingLevel | undefined {
  return LEVEL_ALIASES[value.trim().toLowerCase()]
}

export function canonicalReasoningOptions(values: readonly string[]): Array<{ id: string; level: ThinkingLevel }> {
  const byLevel = new Map<ThinkingLevel, string>()
  for (const id of values) {
    const level = thinkingLevel(id)
    if (level && !byLevel.has(level)) byLevel.set(level, id)
  }
  return THINKING_LEVELS.flatMap((level) => {
    const id = byLevel.get(level)
    return id === undefined ? [] : [{ id, level }]
  })
}
