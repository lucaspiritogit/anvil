import type { JSX } from 'react'
import { useMemo } from 'react'
import { taskRiskFlags, type RiskKind } from '@anvil/protocol/task-risk'
import { cn } from '../ui'

const TONE: Record<RiskKind, string> = {
  secrets: 'border-danger/45 text-danger-text bg-danger-tint',
  migration: 'border-warn/40 text-warn-text bg-warn-tint',
  ci: 'border-warn/40 text-warn-text bg-warn-tint',
  lockfile: 'border-line-strong text-soft bg-overlay',
  deletion: 'border-warn/40 text-warn-text bg-warn-tint',
  unexpected: 'border-line-strong text-soft bg-overlay'
}

function revealFile(path: string): void {
  const section = [...document.querySelectorAll<HTMLElement>('[data-diff-file]')].find((element) => element.dataset.diffFile === path)
  section?.scrollIntoView({ block: 'start' })
}

export function RiskFlags({ patch, expectedFiles }: { patch: string; expectedFiles?: string[] }): JSX.Element | null {
  const flags = useMemo(() => taskRiskFlags(patch, expectedFiles), [patch, expectedFiles])
  if (!flags.length) return null
  return <div role="group" aria-label="Changes to look at" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-4 py-2">
    <span className="mr-1 font-mono text-[10px] tracking-[0.08em] text-faint uppercase">Look at</span>
    {flags.map((flag) => <button
      key={flag.kind}
      type="button"
      className={cn('inline-flex h-[22px] items-center gap-1.5 border px-2 font-mono text-[11px] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent', TONE[flag.kind])}
      title={flag.files.join('\n')}
      onClick={() => revealFile(flag.files[0])}
    >
      {flag.label}
      <span className="tabular-nums opacity-75">{flag.files.length}</span>
    </button>)}
  </div>
}
