import type { JSX } from 'react'
import type { Task, TaskEvent } from '@shared/types'

function activityLabel(task: Task, event?: TaskEvent): string {
  switch (task.deliveryStatus) {
    case 'preparing': return 'Preparing branch…'
    case 'finalizing': return 'Saving changes…'
    case 'did_not_commit': return 'Committing changes…'
  }

  switch (event?.category) {
    case 'thinking': return 'Thinking…'
    case 'message': return 'Writing a response…'
    case 'tool_use': {
      const toolName = event.text.split('\n', 1)[0].trim()
      return toolName ? `Running ${toolName}…` : 'Running a tool…'
    }
    case 'tool_result': return 'Processing tool result…'
    case 'error': return 'Waiting for the agent…'
    default: return 'Working…'
  }
}

export function TaskActivity({ task, event }: { task: Task; event?: TaskEvent }): JSX.Element | null {
  if (task.status !== 'running') return null
  const label = activityLabel(task, event)

  return (
    <div role="status" aria-label="Agent activity" aria-live="polite" aria-atomic="true" className="py-3 text-xs text-dim">
      <span className="block truncate motion-safe:animate-breathe" title={label}>{label}</span>
    </div>
  )
}
