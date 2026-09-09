import type { DeliveryStatus, Issue, TaskStatus } from '@shared/types'

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
  running: 'text-accent',
  succeeded: 'text-ok',
  failed: 'text-danger',
  cancelled: 'text-warn'
}

const DOT_TONE: Record<TaskStatus, string> = {
  pending: 'bg-warn',
  running: 'bg-accent animate-blink',
  succeeded: 'bg-ok',
  failed: 'bg-danger',
  cancelled: 'bg-warn'
}

const DELIVERY_TONE: Partial<Record<DeliveryStatus, string>> = {
  reviewable: 'text-accent',
  approved: 'text-ok',
  did_not_commit: 'text-warn',
  unavailable: 'text-warn',
  failed: 'text-danger',
  agent_failed: 'text-danger'
}

/** The task-status dot: colour plus, while running, the slow blink. */
export function dot(status: TaskStatus, extra?: string): string {
  return cn('flex-none size-[7px] rounded-full', DOT_TONE[status], extra)
}

/** Text colour for a task's execution state. */
export function statusTone(status: TaskStatus): string {
  return STATUS_TONE[status]
}

/** Text colour for a task's code-delivery state; the quiet ones stay dim. */
export function deliveryTone(status: DeliveryStatus): string {
  return DELIVERY_TONE[status] ?? 'text-dim'
}

/** Sub-task badges: a Valence review pauses the agent until the developer answers. */
export const ISSUE_STATUS: Record<Issue['status'], { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: 'text-dim' },
  working: { label: 'Working', tone: 'text-accent' },
  blocked: { label: 'Blocked', tone: 'text-danger' },
  review: { label: 'Review', tone: 'text-warn' },
  complete: { label: 'Finished', tone: 'text-ok' }
}

export const btn = {
  primary:
    'px-3.5 py-[7px] font-medium whitespace-nowrap bg-accent text-canvas disabled:opacity-45 disabled:cursor-not-allowed',
  ghost: 'px-3 py-[7px] border border-line text-dim hover:text-fg',
  danger: 'px-3 py-[5px] border border-line text-danger',
  icon: 'size-[22px] text-[15px] leading-none text-dim hover:text-fg hover:bg-hover',
  text: 'text-xs text-accent'
}

/*
 * `control` carries everything but the size, so a caller that needs a tighter
 * input adds its own padding without two padding utilities racing each other
 * in the stylesheet.
 */
const CONTROL =
  'w-full bg-canvas text-fg border border-line outline-none focus:border-accent'

export const field = {
  wrap: 'block mb-3',
  label: 'block mb-[5px] text-xs text-dim',
  hint: 'block mt-1.5 text-[11px] text-dim',
  control: CONTROL,
  sized: `${CONTROL} px-2.5 py-2`,
  textarea: `${CONTROL} px-2.5 py-2 resize-y font-mono text-[13px]`
}

export const modal = {
  backdrop: 'fixed inset-0 z-[100] grid place-items-center bg-black/55',
  /** Width is the caller's, so the three sizes never overlap. */
  panel: 'max-h-[88vh] p-5 overflow-y-auto bg-raised border border-line',
  width: {
    narrow: 'w-[min(440px,92vw)]',
    normal: 'w-[min(560px,92vw)]',
    wide: 'w-[min(720px,94vw)]'
  },
  title: 'mb-4 text-base font-semibold',
  copy: 'mb-3.5 text-[13px] leading-normal text-dim',
  actions: 'flex gap-2.5 items-center justify-between mt-[18px]',
  section: 'pt-1.5 mt-1.5 border-t border-line',
  toggle: 'flex gap-2.5 items-start p-3 mt-0.5 mb-3 border border-line'
}

/** Small print under a field or beside a modal's buttons; sits tight to what it follows. */
export const hint = '-mt-1.5 mb-3 text-xs text-dim'

/** A card on the overview: the raised, outlined block sections sit in. */
export const card = 'p-[18px] bg-raised border border-line'
