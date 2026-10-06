import type { JSX } from 'react'
import type { TaskStyle } from '@anvil/protocol/types'
import { TASK_STYLE_LABELS } from '@anvil/protocol/task-style'
import { cn } from '../ui'

const TONES: Record<TaskStyle, string> = {
  work: 'border-line-strong bg-overlay text-dim',
  quick: 'border-warn/30 bg-warn-tint text-warn-text'
}

const GLYPHS: Record<TaskStyle, string> = {
  work: '▣',
  quick: '»'
}

export function TaskStyleBadge({ style, className }: { style: TaskStyle; className?: string }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center gap-1.5 border px-1.5 font-mono text-[10px] font-medium tracking-[0.06em] uppercase',
        TONES[style],
        className
      )}
    >
      <span aria-hidden="true">{GLYPHS[style]}</span>
      {TASK_STYLE_LABELS[style]}
    </span>
  )
}
