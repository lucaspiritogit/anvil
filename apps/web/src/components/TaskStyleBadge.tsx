import type { JSX } from 'react'
import type { TaskStyle } from '@anvil/protocol/types'
import { TASK_STYLE_LABELS } from '@anvil/protocol/task-style'
import { Icon, type IconName } from '../icons'
import { cn } from '../ui'

const TONES: Record<TaskStyle, string> = {
  work: 'border-line/80 bg-fg/[0.04] text-dim',
  quick: 'border-warn/30 bg-warn/10 text-warn'
}

const ICONS: Record<TaskStyle, IconName> = {
  work: 'anvil',
  quick: 'rabbit'
}

export function TaskStyleBadge({ style, className }: { style: TaskStyle; className?: string }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-relaxed tracking-wide',
        TONES[style],
        className
      )}
    >
      <Icon icon={ICONS[style]} size={12} className="shrink-0" aria-hidden="true" />
      {TASK_STYLE_LABELS[style]}
    </span>
  )
}
