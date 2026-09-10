import type { Task, TaskIssueSnapshot } from './types'

/** Presentation only: intermediate issue review never changes task delivery eligibility. */
export function taskIssuePresentation(task: Task, snapshot?: TaskIssueSnapshot | null) {
  if (!snapshot?.children.length || task.status === 'succeeded' || task.status === 'cancelled') return null
  const current = snapshot.children.find((issue) => issue.id === snapshot.execution?.currentIssueId)
  const issue = snapshot.children.find((issue) => issue.status === 'review')
    ?? current
    ?? snapshot.children.find((issue) => issue.status === 'working')
    ?? snapshot.children.find((issue) => issue.status === 'blocked')
    ?? snapshot.children.find((issue) => issue.status === 'queued')
    ?? snapshot.children.at(-1)!
  const status = snapshot.execution?.phase === 'blocked' && issue.status !== 'review' ? 'blocked' : issue.status
  const label = { queued: 'Queued', working: 'Working', review: 'Review', complete: 'Subtask complete', blocked: 'Blocked' }[status]
  const detail = status === 'review'
    ? snapshot.reviewReady === false ? 'Waiting for the agent to stop and save changes…' : 'Waiting for your review…'
    : status === 'complete' ? 'Subtask approved' : label
  return { issue, status, label, detail }
}
