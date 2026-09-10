import type { Issue, Task, TaskComment, TaskExecutionState } from '../../shared/types'

// Shared task instructions apply to both agent protocols and non-Git tasks.
// Keep history-only rebases separate: they must not run validation or change files.
const ANVIL_TASK_INSTRUCTIONS = [
  'Keep long-running commands observable. Do not pipe tests, builds, installs, or validation commands through tail, output-capturing substitutions, or filters that hide progress.',
  'Run commands directly or stream and save output with tee. Use a concise reporter that still shows progress. Preserve command failures in pipelines, using pipefail in shells that support it.',
  'Reading existing files or saved logs with tail is fine. Summarize saved output after the command finishes.',
  'Use targeted tests and checks for the current issue or review changes. Expand validation when dependencies or shared behavior change.',
  'Honor required repository checks and issue validation; do not skip or weaken them. Record the commands run and their actual results; do not claim unperformed checks passed.'
].join('\n')

function issueTrackerInstructionsPrompt(): string {
  return 'Use the anvil_issue_tracker tools supplied by Anvil. Call anvil_get_plan to read the current task and its issues. The connection already selects the owning task, project and workspace. Use anvil_create_issue and anvil_update_issue during planning, anvil_block_issue or anvil_requeue_issue for interrupted work, and anvil_submit_review with checklist confirmations and actual validation evidence after committing. Developer approval happens in Anvil.'
}

export function planningPrompt(task: string, state: Pick<TaskExecutionState, 'projectPath' | 'parentIssueId'>): string {
  return [
    ANVIL_TASK_INSTRUCTIONS,
    issueTrackerInstructionsPrompt(),
    'Create issues for this task with findings, paths, checklists, validation, and priorities.',
    `Create issues under parent ${JSON.stringify(state.parentIssueId)}.`,
    'Create prerequisites first; dependencies use their actual issue IDs.',
    'Give each issue targeted validation commands.',
    'Leave the finished plan queued. Do not claim or implement issues. If planning fails, block any partial issues before exiting.',
    'Summarize the plan in plain text.',
    `Task: ${task}`
  ].join('\n')
}

export function implementationPrompt(task: string, issue: Issue, projectPath: string): string {
  const { id, parentId, title, description, checklist, validation } = issue
  return [
    ANVIL_TASK_INSTRUCTIONS,
    'Implement this issue, validate it, and commit.',
    issueTrackerInstructionsPrompt(),
    'Anvil already claimed your issue. Submit it for review with anvil_submit_review only after satisfying its checklist and providing real validation evidence. Anvil then pauses for developer review before any next issue.',
    'Do not claim or create other issues, or change issue ownership or dependencies. If unfinished, block it and explain why in plain text.',
    'Install dependencies locally, without shared node_modules symlinks.',
    'Anvil reads review submission from Valence, not your response. Summarize the outcome in plain text.',
    `Task: ${task}`,
    `Issue: ${JSON.stringify({ id, parentId, title, description, checklist, validation })}`
  ].join('\n')
}

export function taskFollowupPrompt(task: Task, state: TaskExecutionState, message: string): string {
  if (state.phase === 'complete') return [ANVIL_TASK_INSTRUCTIONS, message].join('\n\n')
  if (state.phase === 'planning') return [
    planningPrompt(task.prompt, state),
    'The developer is unblocking planning. Inspect existing issues for this task; fix and requeue partial blocked issues instead of duplicating the plan.',
    `Developer message: ${message}`
  ].join('\n\n')
  return [
    ANVIL_TASK_INSTRUCTIONS,
    'The developer is unblocking this task. Keep its existing plan and branch.',
    issueTrackerInstructionsPrompt(),
    `Original task: ${task.prompt}`,
    `Task issue IDs: ${state.issueIds.join(', ')}`,
    state.currentIssueId
      ? `Resume issue ${state.currentIssueId}. Inspect its status, requeue and start it if blocked, then implement, validate, commit, and submit it for review with anvil_submit_review. If still working, verify it belongs to this interrupted task before requeueing. Do not take over another client's work.`
      : 'Inspect and unblock the remaining task issues so Anvil can schedule them. Leave unfinished issues queued; do not claim new work.',
    'Do not create a replacement plan or claim other issues. Anvil checks Valence review submissions and pauses for developer review after each issue.',
    `Developer message: ${message}`
  ].join('\n\n')
}

export function taskRecoveryPrompt(task: Task, state: TaskExecutionState): string {
  return [
    ANVIL_TASK_INSTRUCTIONS,
    issueTrackerInstructionsPrompt(),
    'Continue from where the previous attempt stopped after a temporary connection failure. This is automatic recovery of the same task and session.',
    'Preserve completed work. Follow the latest user instructions in the saved conversation, including any that override the original request or validation plan below.',
    `Original task: ${task.prompt}`,
    `Task parent: ${state.parentIssueId}`,
    state.phase === 'planning'
      ? 'Inspect the existing plan before adding missing issues. Do not duplicate issues. Leave the finished plan queued without implementing it.'
      : `Continue issue ${state.currentIssueId ?? '(inspect the existing task plan)'}. Check its Valence status before acting. If already submitted, report that result instead of repeating work. Do not claim other issues or create a replacement plan.`
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
    ANVIL_TASK_INSTRUCTIONS,
    issueTrackerInstructionsPrompt(),
    `The developer reviewed issue ${JSON.stringify(issueId)} and requested changes. The issue is working again in Valence.`,
    'Address the notes below in the code, then commit. Do not claim or create other issues, or change issue ownership or dependencies.',
    'Submit the issue for review with anvil_submit_review again once its checklist is satisfied, with real validation evidence. Anvil pauses for developer review after every issue.',
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
    ANVIL_TASK_INSTRUCTIONS,
    'The developer reviewed your changes and left the notes below.',
    'Address each one in the code, then commit.',
    '',
    notes
  ].join('\n')
}
