import type { JSX } from 'react'
import { cn } from '../ui'

export type StatusGlyphName = 'running' | 'done' | 'review' | 'failed' | 'warn' | 'queued' | 'cancelled'

const GLYPHS: Record<Exclude<StatusGlyphName, 'running'>, string> = {
  done: '✓',
  review: '◆',
  failed: '✕',
  warn: '▲',
  queued: '□',
  cancelled: '⊘'
}

export function StatusGlyph({ glyph, className }: { glyph: StatusGlyphName; className?: string }): JSX.Element {
  return (
    <span aria-hidden="true" className={cn('inline-block w-[1ch] text-center font-mono leading-none select-none', glyph === 'running' && 'braille-spin', className)}>
      {glyph === 'running' ? null : GLYPHS[glyph]}
    </span>
  )
}
