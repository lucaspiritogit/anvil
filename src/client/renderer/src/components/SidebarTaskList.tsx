import { isQueuedStackTask } from '@shared/task-stacks'
import type { JSX } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Project, Task, TaskIssueSnapshot } from '@shared/types'
import type { CenterView } from '../state/store'
import { sidebarTaskStacks } from './sidebar-task-stacks'
import { SidebarTask } from './SidebarTask'

interface Props {
  id?: string
  tasks: Task[]
  snapshots: Map<string, TaskIssueSnapshot | null>
  projectById: Map<string, Project>
  now: number
  view: CenterView
  compact?: boolean
  emptyMessage: string
}

export function SidebarTaskList({ id, tasks, snapshots, projectById, now, view, compact = false, emptyMessage }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const entries = useMemo(() => sidebarTaskStacks(tasks), [tasks])
  const layoutKey = JSON.stringify([compact, entries.map(({ task, stackStart, stackEnd }) => [
    task.id, task.restackTarget?.parentTaskId ?? task.parentTaskId, isQueuedStackTask(task), stackStart, stackEnd
  ])])
  const previousLayoutKey = useRef(layoutKey)
  const previousRows = useRef(new Map<string, { top: number; height: number }>())
  const getItemKey = useCallback((index: number) => entries[index].task.id, [entries])
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: (index) => {
      const { task, stackStart, stackEnd } = entries[index]
      const queuedStack = isQueuedStackTask(task)
      const height = queuedStack ? 36 : compact ? 36 + (snapshots.get(task.id)?.children.length ?? 0) * 32 : 96
      return height + (stackStart ? 28 : 0) + (stackEnd ? 28 : 0)
    },
    overscan: 3,
    gap: compact ? 4 : 6
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
      const stacked = element.dataset.stacked === 'true'
      const running = element.getAnimations()
      // Anchor the main task at the top immediately. Only queue entries move
      // into place; animating the parent upward makes the stack grow from below.
      // Mount and scroll measurements establish positions without animation.
      // Only real stack changes can start movement; later measurements may
      // adjust an animation already started by that change.
      if (expanding || reducedMotion) {
        for (const animation of running) animation.cancel()
      } else if ((layoutChanged || running.length > 0) && stacked && previous && height > 0 &&
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
    <div id={id} ref={scrollRef} className="min-h-0 overflow-y-auto overscroll-contain pb-1" style={{ overflowAnchor: 'none' }}>
      <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const { task, stackStart, stackEnd } = entries[row.index]
          return <SidebarTask key={task.id} task={task} snapshot={snapshots.get(task.id)} project={projectById.get(task.projectId)}
            now={now} compact={compact} stackStart={stackStart} stackEnd={stackEnd} active={view.kind === 'task' && view.taskId === task.id}
            rowProps={{
              ref: virtualizer.measureElement,
              'data-index': row.index,
              'data-task-id': task.id,
              'data-stacked': Boolean(task.restackTarget?.parentTaskId ?? task.parentTaskId),
              'data-row-start': row.start,
              'aria-posinset': row.index + 1,
              'aria-setsize': tasks.length,
              className: 'absolute left-0 top-0 w-full flow-root',
              style: { transformOrigin: 'top center', transform: `translateY(${row.start}px)` }
            }} />
        })}
      </ul>
      {!tasks.length && <p className="px-2 py-4 text-xs text-dim">{emptyMessage}</p>}
    </div>
  )
}
