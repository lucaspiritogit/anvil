import type { Issue, Task, TaskComment, TaskExecutionState } from '../../shared/types'

// Shared task instructions apply to both agent protocols and non-Git tasks.
// Keep history-only rebases separate: they must not run validation or change files.
const ANVIL_TASK_INSTRUCTIONS = [
  'Keep plans, findings, progress notes, and validation results in Anvil issues and responses. Do not create documentation files or documentation-only issues unless the user requests them. Update existing documentation only when needed to keep it accurate for the requested change.',
  'Keep long-running commands observable. Do not pipe tests, builds, installs, or validation commands through tail, output-capturing substitutions, or filters that hide progress.',
  'Run commands directly or stream and save output with tee. Use a concise reporter that still shows progress. Preserve command failures in pipelines, using pipefail in shells that support it.',
  'Reading existing files or saved logs with tail is fine. Summarize saved output after the command finishes.',
  'Use targeted tests and checks for the current issue or review changes. Expand validation when dependencies or shared behavior change.',
  'Honor required repository checks and issue validation; do not skip or weaken them. Record the commands run and their actual results; do not claim unperformed checks passed.'
].join('\n')

function issueTrackerInstructionsPrompt(): string {
  return 'Use the supplied anvil_issue_tracker tools. If not visible, discover them through the available tool search/list facility. Call anvil_get_plan for current issue context and status. Follow the discovered MCP schema for arguments and call the tool directly. The connection supplies task ownership; no database access, credentials, or hand-written HTTP is needed.'
}

const PLANNING_TOOLS = 'Use anvil_create_issue and anvil_update_issue to build the queued plan. Use anvil_requeue_issue for repaired blocked planning issues and anvil_block_issue only for unfinished planning.'

const REVIEW_TOOLS = 'After satisfying the checklist, validating, and committing, call anvil_submit_review and require a successful result before reporting submission. Prose is never a review submission. Anvil pauses for developer review; only the developer approves. If unfinished, use anvil_block_issue and explain why in plain text.'

function interruptedIssuePrompt(issueId: string | null): string {
  if (!issueId) return 'Inspect the plan. Use anvil_requeue_issue only for blocked remaining task issues so Anvil can schedule them. Do not claim new work.'
  return [
    `Continue issue ${issueId}. Read its status with anvil_get_plan before acting.`,
    'If blocked, use anvil_requeue_issue then anvil_start_issue for this current interrupted issue. If queued, use anvil_start_issue. If working, continue without requeueing. If already submitted (review or done), report that result instead of repeating work or submitting again.',
    'For unfinished work, implement, validate, and commit. Do not claim other issues or create a replacement plan.',
    REVIEW_TOOLS
  ].join('\n')
}

export function planningPrompt(task: string, state: Pick<TaskExecutionState, 'projectPath' | 'parentIssueId'>): string {
  return [
    ANVIL_TASK_INSTRUCTIONS,
    issueTrackerInstructionsPrompt(),
    PLANNING_TOOLS,
    'Create issues for this task with findings, paths, checklists, validation, and priorities.',
    'Create prerequisites first; dependencies use their actual issue IDs.',
    'Give each issue targeted validation commands.',
    'Leave the finished plan queued. Do not claim or implement issues. If planning fails, block any partial issues before exiting.',
    'Summarize the plan in plain text.',
    `Task: ${task}`
  ].join('\n')
}

export function implementationPrompt(task: string, issue: Issue, projectPath: string): string {
  const { id, title, description, checklist, validation } = issue
  return [
    ANVIL_TASK_INSTRUCTIONS,
    'Implement this issue, validate it, and commit.',
    issueTrackerInstructionsPrompt(),
    'Anvil already claimed your issue.',
    REVIEW_TOOLS,
    'Do not claim or create other issues, or change issue ownership or dependencies.',
    'Install dependencies locally, without shared node_modules symlinks.',
    'Summarize the outcome in plain text.',
    `Task: ${task}`,
    `Issue: ${JSON.stringify({ id, title, description, checklist, validation })}`
  ].join('\n')
}

export function taskFollowupPrompt(state: TaskExecutionState, message: string): string {
  if (state.phase === 'complete') return message
  const instruction = state.currentIssueId
    ? `Resume issue ${state.currentIssueId}`
    : 'Resume task with anvil_get_plan'
  return `${instruction}\n\n${message}`
}

export function taskRecoveryPrompt(task: Task, state: TaskExecutionState): string {
  return [
    ANVIL_TASK_INSTRUCTIONS,
    issueTrackerInstructionsPrompt(),
    'Continue from where the previous attempt stopped after a temporary connection failure. This is automatic recovery of the same task and session.',
    'Preserve completed work. Follow the latest user instructions in the saved conversation, including any that override the original request or validation plan below.',
    `Original task: ${task.prompt}`,
    state.phase === 'planning'
      ? `${PLANNING_TOOLS} Inspect the existing plan before adding missing issues. Do not duplicate issues. Leave the finished plan queued without implementing it.`
      : interruptedIssuePrompt(state.currentIssueId)
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
    `The developer reviewed issue ${JSON.stringify(issueId)} and requested changes. The issue is working again.`,
    'Address the notes below in the code, validate, then commit. Do not claim or create other issues, or change issue ownership or dependencies.',
    REVIEW_TOOLS,
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
