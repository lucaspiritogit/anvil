import type { Issue, Task, TaskComment, TaskExecutionState } from '../../shared/types'

function valenceIssueTrackerInstructionsPrompt(projectPath: string): string {
  return `Use vl --project ${JSON.stringify(projectPath)} <command>. Run vl --help for commands. The launcher selects the owning Anvil database; --project selects the registered original project. init only checks storage readiness.`
}

export function planningPrompt(task: string, state: Pick<TaskExecutionState, 'projectPath' | 'parentIssueId'>): string {
  return [
    valenceIssueTrackerInstructionsPrompt(state.projectPath),
    'Create issues for this task with findings, paths, checklists, validation, and priorities.',
    `Create issues under parent ${JSON.stringify(state.parentIssueId)}.`,
    'Create prerequisites first; dependencies use their actual issue IDs.',
    'Leave the finished plan queued. Do not claim or implement issues. If planning fails, block any partial issues before exiting.',
    'Summarize the plan in plain text.',
    `Task: ${task}`
  ].join('\n')
}

export function implementationPrompt(task: string, issue: Issue, projectPath: string): string {
  const { id, parentId, title, description, checklist, validation } = issue
  return [
    'Implement this issue, validate it, and commit.',
    valenceIssueTrackerInstructionsPrompt(projectPath),
    'Anvil already claimed your issue. Submit it for review through vl only after satisfying its checklist (vl submit-review with --confirm-checklist and real validation evidence). Anvil then pauses for developer review before any next issue.',
    'Do not claim or create other issues, or change issue ownership or dependencies. If unfinished, block it and explain why in plain text.',
    'Install dependencies locally, without shared node_modules symlinks.',
    'Anvil reads review submission from Valence, not your response. Summarize the outcome in plain text.',
    `Task: ${task}`,
    `Issue: ${JSON.stringify({ id, parentId, title, description, checklist, validation })}`
  ].join('\n')
}

export function taskFollowupPrompt(task: Task, state: TaskExecutionState, message: string): string {
  if (state.phase === 'complete') return message
  if (state.phase === 'planning') return [
    planningPrompt(task.prompt, state),
    'The developer is unblocking planning. Inspect existing issues for this task; fix and requeue partial blocked issues instead of duplicating the plan.',
    `Developer message: ${message}`
  ].join('\n\n')
  return [
    'The developer is unblocking this task. Keep its existing plan and branch.',
    valenceIssueTrackerInstructionsPrompt(state.projectPath),
    `Original task: ${task.prompt}`,
    `Task issue IDs: ${state.issueIds.join(', ')}`,
    state.currentIssueId
      ? `Resume issue ${state.currentIssueId}. Inspect its status, requeue and start it if blocked, then implement, validate, commit, and submit it for review through vl. If still working, verify it belongs to this interrupted task before requeueing. Do not take over another client's work.`
      : 'Inspect and unblock the remaining task issues so Anvil can schedule them. Leave unfinished issues queued; do not claim new work.',
    'Do not create a replacement plan or claim other issues. Anvil checks Valence review submissions and pauses for developer review after each issue.',
    `Developer message: ${message}`
  ].join('\n\n')
}

function commentNotes(comments: TaskComment[]): string {
  return comments
    .map((comment) => comment.file ? `${comment.file}:${comment.lineNumber} — ${comment.body}` : comment.body)
    .join('\n')
}

export function issueReworkPrompt(projectPath: string, issueId: string, comments: TaskComment[]): string {
  const notes = commentNotes(comments)
  return [
    valenceIssueTrackerInstructionsPrompt(projectPath),
    `The developer reviewed issue ${JSON.stringify(issueId)} and requested changes. The issue is working again in Valence.`,
    'Address the notes below in the code, then commit. Do not claim or create other issues, or change issue ownership or dependencies.',
    'Submit the issue for review through vl again once its checklist is satisfied, with real validation evidence. Anvil pauses for developer review after every issue.',
    '',
    notes
  ].join('\n')
}

export function agentRebasePrompt(baseCommit: string): string {
  return [
    `Rebase the commits on this branch into a single commit on top of ${baseCommit}.`,
    '',
    `Run \`git reset --soft ${baseCommit}\` and then commit the staged changes once.`,
    'Write the commit message yourself, covering the whole of the work.',
    `Do not alter, drop or reorder anything at or before ${baseCommit}, do not discard`,
    'changes, and do not rebase, amend earlier history, or push.',
    'Change no files: this is only a history operation.'
  ].join('\n')
}

export function reviewPrompt(comments: TaskComment[]): string {
  const notes = commentNotes(comments)
  return [
    'The developer reviewed your changes and left the notes below.',
    'Address each one in the code, then commit.',
    '',
    notes
  ].join('\n')
}
