import type { DeliveryStatus, Issue, TaskStatus } from '@anvil/protocol/types'

/** Joins class names, dropping the falsy branches of a conditional. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/*
 * Tailwind only sees class names it can read as literal text, so a status can
 * never be interpolated into one. These maps are the lookup that replaces the
 * `dot-${status}` style of class the stylesheet used to rely on.
 */
const STATUS_TONE: Record<TaskStatus, string> = {
  pending: 'text-warn',
  running: 'text-run',
  succeeded: 'text-ok',
  failed: 'text-danger',
  cancelled: 'text-warn'
}

const DOT_TONE: Record<TaskStatus, string> = {
  pending: 'bg-warn',
  running: 'bg-run animate-blink',
  succeeded: 'bg-ok',
  failed: 'bg-danger',
  cancelled: 'bg-warn'
}

const DELIVERY_TONE: Partial<Record<DeliveryStatus, string>> = {
  reviewable: 'text-review',
  merge_conflict: 'text-warn',
  approved: 'text-ok',
  did_not_commit: 'text-warn',
  unavailable: 'text-warn',
  failed: 'text-danger',
  agent_failed: 'text-danger'
}

/** The task-status dot: colour plus, while running, the slow blink. */
export function dot(status: TaskStatus, extra?: string): string {
  return cn('flex-none size-2', DOT_TONE[status], extra)
}

/** Text colour for a task's execution state. */
export function statusTone(status: TaskStatus): string {
  return STATUS_TONE[status]
}

/** Text colour for a task's code-delivery state; the quiet ones stay dim. */
export function deliveryTone(status: DeliveryStatus): string {
  return DELIVERY_TONE[status] ?? 'text-dim'
}

/** Sub-task badges: an Anvil issue tracker review pauses the agent until the developer answers. */
export const ISSUE_STATUS: Record<Issue['status'], { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: 'text-dim' },
  working: { label: 'Working', tone: 'text-run' },
  blocked: { label: 'Blocked', tone: 'text-danger' },
  review: { label: 'Review', tone: 'text-review' },
  complete: { label: 'Finished', tone: 'text-ok' }
}

export const btn = {
  primary:
    'px-3.5 py-[7px] font-semibold whitespace-nowrap bg-accent text-canvas transition-[filter,background-color] duration-[120ms] enabled:hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:bg-overlay disabled:text-faint disabled:cursor-not-allowed',
  ghost: 'px-3 py-[7px] border border-line-strong bg-overlay text-fg transition-colors duration-[120ms] enabled:hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:text-faint disabled:cursor-not-allowed',
  danger: 'px-3 py-[5px] border border-danger/35 bg-danger-tint text-danger-text transition-colors duration-[120ms] enabled:hover:border-danger/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 disabled:cursor-not-allowed',
  icon: 'size-[22px] text-[15px] leading-none text-dim hover:text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent',
  text: 'text-xs text-ember-400 hover:text-ember-300'
}

/*
 * `control` carries everything but the size, so a caller that needs a tighter
 * input adds its own padding without two padding utilities racing each other
 * in the stylesheet.
 */
const CONTROL =
  'w-full bg-canvas text-fg border border-line-strong outline-none placeholder:text-faint focus:border-accent'

export const field = {
  wrap: 'block mb-3',
  label: 'block mb-[6px] font-mono text-[11px] font-medium tracking-[0.12em] uppercase text-dim',
  hint: 'block mt-1.5 text-xs text-dim',
  control: CONTROL,
  sized: `${CONTROL} px-2.5 py-2`,
  textarea: `${CONTROL} px-2.5 py-2 resize-y font-mono text-[13px]`
}

export const modal = {
  backdrop: 'fixed inset-0 z-[100] grid place-items-center bg-void/75',
  /** Width is the caller's, so the three sizes never overlap. */
  panel: 'max-h-[88vh] p-5 overflow-y-auto bg-overlay border border-line-strong',
  width: {
    narrow: 'w-[min(440px,92vw)]',
    normal: 'w-[min(560px,92vw)]',
    wide: 'w-[min(720px,94vw)]'
  },
  title: 'mb-4 font-mono text-base font-semibold tracking-[-0.01em]',
  copy: 'mb-3.5 text-[13px] leading-normal text-dim',
  actions: 'flex gap-2.5 items-center justify-between mt-[18px]',
  section: 'pt-1.5 mt-1.5 border-t border-line',
  toggle: 'flex gap-2.5 items-start p-3 mt-0.5 mb-3 border border-line bg-raised'
}

/** Small print under a field or beside a modal's buttons; sits tight to what it follows. */
export const hint = '-mt-1.5 mb-3 text-xs text-dim'

/** A card on the overview: the raised, outlined block sections sit in. */
export const card = 'p-[18px] bg-raised border border-line'
