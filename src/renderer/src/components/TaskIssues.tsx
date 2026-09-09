import { useState } from 'react'
import type { Issue, TaskIssueSnapshot } from '@shared/types'
import { useTaskIssues } from '../hooks/use-task-issues'
import { btn, cn, ISSUE_STATUS } from '../ui'

export function TaskIssues({ taskId, active }: { taskId: string; active: boolean }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { snapshot, loading, error, refresh } = useTaskIssues(taskId, active, selectedId)
  const card = (issue: Pick<TaskIssueSnapshot['parent'], 'id' | 'title' | 'description'>, status?: Issue['status']): React.JSX.Element => {
    const expanded = selectedId === issue.id
    return <div className="border border-line bg-raised" data-issue-id={issue.id}>
      <button
        type="button"
        className="flex w-full min-w-0 flex-wrap items-start gap-2 p-4 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
        aria-expanded={expanded}
        aria-controls={`issue-summary-${issue.id}`}
        onClick={() => setSelectedId(expanded ? null : issue.id)}
      >
        <span aria-hidden="true" className="text-dim">{expanded ? '−' : '+'}</span>
        <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">{issue.title}</span>
        {status && <span className={cn('border border-line px-2 py-0.5 text-xs', ISSUE_STATUS[status].tone)}>{ISSUE_STATUS[status].label}</span>}
      </button>
      <div id={`issue-summary-${issue.id}`} hidden={!expanded} className="border-t border-line p-4 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {issue.description.trim() ? issue.description : 'No description provided.'}
      </div>
    </div>
  }
  return <section
    id="task-panel-issues" role="tabpanel" aria-labelledby="task-tab-issues" tabIndex={0}
    hidden={!active}
    className={cn('min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-5 focus-visible:outline-accent', !active && 'hidden')}
  >
    {error && <div role="alert" className="mb-4 border border-danger/40 p-3 text-sm [overflow-wrap:anywhere]">
      <p>{snapshot ? 'Could not refresh issues. Showing last known data.' : 'Could not load issues.'}</p>
      <p className="mt-1 text-dim">{error}</p>
      <button className={cn(btn.ghost, 'mt-2')} onClick={refresh}>Retry</button>
    </div>}
    {loading && !snapshot && !error && <p role="status" className="text-sm text-dim">Loading issues…</p>}
    {!loading && !snapshot && !error && <p className="text-sm text-dim">No execution metadata is available for this task.</p>}
    {snapshot && <>
      <section aria-label="Parent issue">
        <h2 className="mb-2 text-xs font-medium text-dim">Parent issue</h2>
        {card(snapshot.parent)}
      </section>
      <section aria-label="Child issues" className="mt-6 border-l border-line pl-4">
        <h2 className="mb-2 text-xs font-medium text-dim">Child issues · {snapshot.children.length}</h2>
        {snapshot.children.length === 0 ? <p className="text-sm text-dim">No child issues yet.</p> :
          <ol className="space-y-3">{snapshot.children.map((issue) => <li key={issue.id}>{card(issue, issue.status)}</li>)}</ol>}
      </section>
    </>}
  </section>
}
