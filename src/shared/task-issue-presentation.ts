import type { Task, TaskIssueSnapshot } from './types'

/** Missing readiness is supported only for legacy snapshots without an execution contract. */
export function issueIsReviewReady(snapshot?: TaskIssueSnapshot | null): boolean {
  return snapshot?.reviewReady === true || Boolean(snapshot && !snapshot.execution && snapshot.reviewReady !== false)
}

export function issuePresentation(issue: TaskIssueSnapshot['children'][number], snapshot?: TaskIssueSnapshot | null, task?: Task) {
  const saving = issue.status === 'review' && (!issueIsReviewReady(snapshot) || task?.deliveryStatus === 'finalizing' || task?.deliveryStatus === 'did_not_commit')
  const status = saving ? 'working' : issue.status
  const label = saving ? 'Saving changes…' : status === 'complete'
    ? issue.reviewedAt != null ? 'Approved' : 'Done'
    : { queued: 'Queued', working: 'Working', review: 'Review', blocked: 'Blocked' }[status]
  return { status, label, saving }
}

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
  const display = issuePresentation(issue, snapshot, task)
  const status = snapshot.execution?.phase === 'blocked' && issue.status !== 'review' ? 'blocked' : display.status
  const label = status === 'blocked' ? 'Blocked' : display.label
  const detail = status === 'review'
    ? 'Waiting for your review…'
    : status === 'complete' ? issue.reviewedAt != null ? 'Subtask approved' : 'Subtask complete' : label
  return { issue, status, label, detail }
}
