import type { JSX } from 'react'
import { useCallback, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Project, Task, TaskIssueSnapshot } from '@shared/types'
import type { CenterView } from '../state/store'
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
  const getItemKey = useCallback((index: number) => tasks[index].id, [tasks])
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: (index) => compact ? 36 + (snapshots.get(tasks[index].id)?.children.length ?? 0) * 32 : 96,
    overscan: 3,
    gap: compact ? 4 : 6
  })

  return (
    <div id={id} ref={scrollRef} className="min-h-0 overflow-y-auto overscroll-contain pb-1" style={{ overflowAnchor: 'none' }}>
      <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const task = tasks[row.index]
          return <SidebarTask key={task.id} task={task} snapshot={snapshots.get(task.id)} project={projectById.get(task.projectId)}
            now={now} compact={compact} active={view.kind === 'task' && view.taskId === task.id}
            rowProps={{
              ref: virtualizer.measureElement,
              'data-index': row.index,
              'aria-posinset': row.index + 1,
              'aria-setsize': tasks.length,
              className: 'absolute left-0 top-0 w-full flow-root',
              style: { transform: `translateY(${row.start}px)` }
            }} />
        })}
      </ul>
      {!tasks.length && <p className="px-2 py-4 text-xs text-dim">{emptyMessage}</p>}
    </div>
  )
}
