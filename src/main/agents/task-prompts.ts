import type { Issue, Task, TaskComment, TaskExecutionState } from '../../shared/types'

function issueTrackerInstructionsPrompt(): string {
  return [
    'Use anvil_issue_tracker tools; discover them through the available tool search/list facility if needed. Call anvil_get_plan for context and status. Follow the discovered MCP schema. The connection supplies ownership; no database access, credentials, or hand-written HTTP is needed.',
    'Check task.branchName and task.canNameBranch. If eligible, choose a concise descriptive name via anvil_set_task_branch now; retry invalid/colliding names. After interruption retry temporary anvil-tmp/<task-id> names; no prompt fallback. Keep accepted/legacy names; skip non-Git/ineligible tasks. Use this agent/model/session, never a separate naming request.'
  ].join('\n')
}

const PLANNING_TOOLS = 'Declare expectedFiles for every issue using repo-relative paths, or [] when no files are expected. Use anvil_create_issue and anvil_update_issue to build the queued plan. Use anvil_requeue_issue for repaired blocked planning issues and anvil_block_issue only for unfinished planning.'

const PLANNING_VALIDATION = 'Give each issue one narrow validation check or a short justified list for its changed paths.'

const REVIEW_TOOLS = 'After satisfying the checklist, validating, and committing any changes, call anvil_submit_review and require a successful result. End the turn: Anvil verifies finalized changes and a clean worktree. Empty changes complete automatically; otherwise Anvil pauses for developer review; only the developer approves. No empty commit is needed. If unfinished, use anvil_block_issue and explain why in plain text.'

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
    issueTrackerInstructionsPrompt(),
    PLANNING_TOOLS,
    'Create issues for this task with findings, paths, checklists, validation, and priorities.',
    'Create prerequisites first; dependencies use their actual issue IDs.',
    PLANNING_VALIDATION,
    'Leave the finished plan queued. Do not claim or implement issues. If planning fails, block any partial issues before exiting.',
    'Summarize the plan in plain text.',
    `Task: ${task}`
  ].join('\n')
}

export function implementationPrompt(task: string, issue: Issue, projectPath: string): string {
  const { id, title, description, checklist, validation } = issue
  return [
    'Implement this issue, validate it, and commit.',
    issueTrackerInstructionsPrompt(),
    'Anvil already claimed your issue.',
    REVIEW_TOOLS,
    'Do not claim or create other issues, or change issue ownership or dependencies.',
    'Summarize the outcome in plain text.',
    `Task: ${task}`,
    `Issue: ${JSON.stringify({ id, title, description, checklist, validation })}`
  ].join('\n')
}

export function taskFollowupPrompt(state: TaskExecutionState, message: string): string {
  if (state.phase === 'complete') return `${issueTrackerInstructionsPrompt()}\n\n${message}`
  const instruction = state.currentIssueId
    ? `Resume issue ${state.currentIssueId}`
    : 'Resume task with anvil_get_plan'
  return `${instruction}\n\n${issueTrackerInstructionsPrompt()}\n\n${message}`
}

export function taskRecoveryPrompt(task: Task, state: TaskExecutionState): string {
  return [
    issueTrackerInstructionsPrompt(),
    'Continue from where the previous attempt stopped after a temporary connection failure. This is automatic recovery of the same task and session.',
    'Preserve completed work. Follow the latest user instructions in the saved conversation, including any that override the original request or validation plan below.',
    `Original task: ${task.prompt}`,
    state.phase === 'planning'
      ? `${PLANNING_TOOLS}\n${PLANNING_VALIDATION}\nInspect the existing plan before adding missing issues. Do not duplicate issues. Leave the finished plan queued without implementing it.`
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
    issueTrackerInstructionsPrompt(),
    'The developer reviewed your changes and left the notes below.',
    'Address each one in the code, then commit.',
    '',
    notes
  ].join('\n')
}
