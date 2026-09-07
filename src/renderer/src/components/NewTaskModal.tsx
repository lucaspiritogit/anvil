import type { JSX } from 'react'
import { useEffect } from 'react'
import { useStore } from '../state/store'
import { btn, cn, modal } from '../ui'
import { TaskComposer } from './TaskComposer'

export function NewTaskModal(): JSX.Element {
  const setNewTaskOpen = useStore((state) => state.setNewTaskOpen)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setNewTaskOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setNewTaskOpen])

  return (
    <div className={modal.backdrop} onClick={() => setNewTaskOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Start new task"
        className={cn(modal.panel, modal.width.normal)}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className={modal.title}>Start new task</h2>
        <TaskComposer />
        <div className="mt-3 flex justify-end">
          <button className={btn.ghost} onClick={() => setNewTaskOpen(false)}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
