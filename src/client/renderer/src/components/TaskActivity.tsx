import type { taskIssuePresentation } from '@shared/task-issue-presentation'
import type { JSX } from 'react'
import type { Task, TaskEvent } from '@shared/types'

function activityLabel(task: Task, event?: TaskEvent): string {
  switch (task.deliveryStatus) {
    case 'preparing': return 'Preparing branch…'
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

export function TaskActivity({ task, event, presentation }: { presentation?: ReturnType<typeof taskIssuePresentation>; task: Task; event?: TaskEvent }): JSX.Element | null {
  if (task.status !== 'running' || (presentation && presentation.status !== 'working')) return null
  const label = activityLabel(task, event)

  return (
    <div role="status" aria-label="Agent activity" aria-live="polite" aria-atomic="true" className="py-3 text-xs text-dim">
      <span className="flex items-center gap-1.5 motion-safe:animate-breathe">
        <span className="block truncate" title={label}>{label}</span>
        <span aria-hidden className="h-3 w-[2px] shrink-0 bg-accent motion-safe:animate-blink" />
      </span>
    </div>
  )
}
