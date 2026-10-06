import { isQueuedStackTask } from '@anvil/protocol/task-stacks'
import type { JSX } from 'react'
import { useCallback, useLayoutEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TaskIssueSnapshot } from '@anvil/protocol/types'
import type { CenterView } from '../state/store'
import { Icon } from '../icons'
import { cn } from '../ui'
import type { SidebarTaskEntry } from './sidebar-task-projects'
import { SidebarTask } from './SidebarTask'

interface Props {
  entries: SidebarTaskEntry[]
  snapshots: Map<string, TaskIssueSnapshot | null>
  now: number
  view: CenterView
  activeProjectId: string | null
  onSelectProject: (projectId: string) => void
  onToggleProject: (projectId: string, expanded: boolean) => void
  onToggleSettled: (groupId: string, expanded: boolean) => void
  onToggleStack: (rootId: string) => void
  onNavigate?: () => void
}

export function SidebarTaskList({ entries, snapshots, now, view, activeProjectId, onSelectProject, onToggleProject, onToggleSettled, onToggleStack, onNavigate }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const layoutKey = JSON.stringify(entries.map((entry) => entry.kind === 'task' ? [
    entry.task.id, entry.task.restackTarget?.parentTaskId ?? entry.task.parentTaskId,
    isQueuedStackTask(entry.task), entry.compact, entry.stackStart, entry.stackEnd, entry.tree?.collapsed
  ] : entry.key))
  const previousLayoutKey = useRef(layoutKey)
  const previousRows = useRef(new Map<string, { top: number; height: number }>())
  const getItemKey = useCallback((index: number) => entries[index].key, [entries])
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: (index) => {
      const entry = entries[index]
      if (entry.kind !== 'task') return entry.kind === 'empty' ? 44 : 36
      const { task, compact } = entry
      const queuedStack = isQueuedStackTask(task)
      const height = queuedStack ? 36 : compact ? 36 + (snapshots.get(task.id)?.children.length ?? 0) * 32 : 96
      return height
    },
    overscan: 3,
    gap: 0
  })

  useLayoutEffect(() => {
    const layoutChanged = previousLayoutKey.current !== layoutKey
    previousLayoutKey.current = layoutKey
    const nextRows = new Map<string, { top: number; height: number }>()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const expanding = Boolean(scrollRef.current?.querySelector('[data-expanding="true"]'))
    for (const element of scrollRef.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? []) {
      // ResizeObserver tracks each height frame. Measure the first frame here
      // as well, before the browser can paint offsets from the full row height.
      if (expanding) virtualizer.measureElement(element)
      const taskId = element.dataset.taskId!
      const top = Number(element.dataset.rowStart)
      const height = element.offsetHeight
      const previous = previousRows.current.get(taskId)
      nextRows.set(taskId, { top, height })
      const stackMoving = element.dataset.stackMoving === 'true'
      const running = element.getAnimations()
      // Anchor the root task at the top immediately. Descendants move into
      // place below it so a newly stacked task settles into the tree.
      // Mount and scroll measurements establish positions without animation.
      // Only real stack changes can start movement; later measurements may
      // adjust an animation already started by that change.
      if (expanding || reducedMotion) {
        for (const animation of running) animation.cancel()
      } else if ((layoutChanged || running.length > 0) && stackMoving && previous && height > 0 &&
        (previous.top !== top || previous.height !== height)) {
        const currentTransform = getComputedStyle(element).transform
        for (const animation of running) animation.cancel()
        element.animate([
          { transform: running.length ? currentTransform : `translateY(${previous.top}px) scaleY(${previous.height / height})` },
          { transform: `translateY(${top}px) scaleY(1)` }
        ], { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
      }
    }
    previousRows.current = nextRows
  })

  return (
    <div ref={scrollRef} className="min-h-0 overflow-y-auto overscroll-contain pb-1" style={{ overflowAnchor: 'none' }}>
      <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const entry = entries[row.index]
          const rowProps = {
            ref: virtualizer.measureElement,
            'data-index': row.index,
            'data-row-start': row.start,
            'aria-posinset': row.index + 1,
            'aria-setsize': entries.length,
            className: 'absolute left-0 top-0 w-full flow-root',
            style: { transformOrigin: 'top center', transform: `translateY(${row.start}px)` }
          }
          if (entry.kind === 'task') {
            const { task, project, compact, tree } = entry
            return <SidebarTask key={entry.key} task={task} snapshot={snapshots.get(task.id)} project={project}
              now={now} compact={compact} tree={tree} onToggleStack={onToggleStack} active={view.kind === 'task' && view.taskId === task.id}
              onNavigate={onNavigate}
              rowProps={{ ...rowProps, 'data-task-id': task.id,
                'data-stack-moving': Boolean(tree && tree.depth > 0) }} />
          }
          if (entry.kind === 'project') {
            const { project, expanded, taskCount } = entry
            return <li key={entry.key} {...rowProps}>
              <div className={cn('flex min-h-9 items-center px-2 pt-1 font-mono text-[11px] tracking-[0.12em]', activeProjectId === project.id ? 'text-fg' : 'text-dim')}>
                <button type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} project: ${project.name}`}
                  aria-expanded={expanded} onClick={() => onToggleProject(project.id, expanded)}
                  className="grid size-7 shrink-0 place-items-center hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-accent">
                  <Icon icon="chevron-down" size={12} className={cn('transition-transform', !expanded && '-rotate-90')} aria-hidden="true" />
                </button>
                <button type="button" aria-label={`Select project: ${project.name}`}
                  aria-current={activeProjectId === project.id && view.kind === 'home' ? 'page' : undefined}
                  onClick={() => onSelectProject(project.id)} title={project.path}
                  className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-1 pr-2 text-left hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-accent">
                  <span className="min-w-0 flex-1 truncate font-medium uppercase">{project.name}</span>
                  <span className="shrink-0 text-[11px] text-dim tabular-nums">{taskCount}</span>
                </button>
              </div>
            </li>
          }
          if (entry.kind === 'settled') {
            return <li key={entry.key} {...rowProps}>
              <button type="button" aria-label={entry.project ? `Settled tasks in ${entry.project.name}` : 'Settled tasks with no project'}
                aria-expanded={entry.expanded} onClick={() => onToggleSettled(entry.groupId, entry.expanded)}
                className="flex min-h-9 w-full items-center gap-2 px-4 font-mono text-[11px] text-faint hover:text-fg focus-visible:outline focus-visible:outline-accent">
                <Icon icon="chevron-down" size={13} className={cn('transition-transform', !entry.expanded && '-rotate-90')} aria-hidden="true" />
                <span>Settled</span>
                <span className="text-faint">{entry.taskCount}</span>
                <span className="h-px flex-1 border-t border-dashed border-line-strong" />
              </button>
            </li>
          }
          return <li key={entry.key} {...rowProps}><p className="px-4 py-3 font-mono text-[11px] text-faint">{entry.message}</p></li>
        })}
      </ul>
    </div>
  )
}
