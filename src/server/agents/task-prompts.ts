import type { Issue, Task, TaskComment, TaskExecutionState, TaskMergeConflict, TaskStyle } from '../../shared/types'

const TOOLS = 'Use anvil_issue_tracker tools.'
export const BROWSER_TOOL_INSTRUCTION = 'Prefer anvil_browser to render UI changes for the user.'
const FINISH_ISSUE = 'Commit finished work and call anvil_submit_review. Call anvil_block_issue if unfinished.'

export function planningPrompt(task: string, _state: Pick<TaskExecutionState, 'projectPath' | 'parentIssueId'>): string {
  return [
    'Create a queued issue plan. Do not implement it.',
    `Task: ${task}`,
    TOOLS
  ].join('\n')
}

export function implementationPrompt(task: string, issue: Issue, _projectPath: string): string {
  const { id, title, description, checklist, validation } = issue
  return [
    'Implement and validate the current issue. Install necessary dependencies from the project package manager if needed.',
    FINISH_ISSUE,
    `Task: ${task}`,
    `Issue: ${JSON.stringify({ id, title, description, checklist, validation })}`,
    TOOLS
  ].join('\n')
}

export function quickTaskPrompt(_style: Exclude<TaskStyle, 'work'>, task: string): string {
  return [
    'Answer or complete the request directly in the current project checkout in one turn.',
    'Do not create an issue plan or another worktree. Do not commit or push unless the request explicitly asks for it.',
    `Request: ${task}`
  ].join('\n')
}

export function taskFollowupPrompt(state: TaskExecutionState, message: string): string {
  if (state.style === 'quick') return quickTaskPrompt(state.style, message)
  if (state.phase === 'complete') return message
  const instruction = state.currentIssueId ? `Resume issue ${state.currentIssueId}` : 'Resume task with anvil_get_plan'
  return `${instruction}\n\n${message}`
}

export function taskRecoveryPrompt(task: Task, state: TaskExecutionState): string {
  if (state.style === 'quick') {
    return [
      'Continue after the connection failure. Preserve completed work and follow the latest request.',
      quickTaskPrompt(state.style, task.prompt)
    ].join('\n')
  }
  const work = state.phase === 'planning'
    ? 'Continue planning. Do not implement.'
    : state.currentIssueId
      ? `Continue issue ${state.currentIssueId}.`
      : 'Continue the task.'
  return [
    'Continue after the connection failure. Preserve completed work and follow the latest instructions.',
    work,
    `Task: ${task.prompt}`,
    TOOLS
  ].join('\n')
}

function commentNotes(comments: TaskComment[]): string {
  return comments
    .map((comment) => comment.file ? `${comment.file}:${comment.lineNumber}: ${comment.body}` : comment.body)
    .join('\n')
}

export function issueReworkPrompt(_projectPath: string, issueId: string, comments: TaskComment[]): string {
  return [
    `The developer reviewed issue ${JSON.stringify(issueId)}.`,
    commentNotes(comments),
    FINISH_ISSUE,
    TOOLS
  ].join('\n')
}

export function agentRebasePrompt(baseCommit: string): string {
  return [
    `Run \`git reset --soft ${baseCommit}\` and commit once.`,
    'Do not change files or earlier history.'
  ].join('\n')
}

export function mergeConflictRepairPrompt(
  conflict: Pick<TaskMergeConflict, 'sourceBranch' | 'targetBranch'>,
  unresolvedFiles: string[]
): string {
  return [
    'Repair the existing paused Git merge in this target project checkout.',
    `Source branch: ${JSON.stringify(conflict.sourceBranch)}`,
    `Target branch: ${JSON.stringify(conflict.targetBranch)}`,
    'Unresolved files:',
    ...unresolvedFiles.map((path) => `- ${JSON.stringify(path)}`),
    'Resolve every conflict while preserving the intended changes from both branches.',
    'Stage every resolved file and finish the existing merge with its current merge message.',
    'Do not checkout or switch branches, reset, abort the merge, create another worktree, or change the task or issue status.',
    'Do not use Anvil issue-tracker tools during this repair.',
    'Leave the repository clean with the merge completed.'
  ].join('\n')
}

export function reviewPrompt(comments: TaskComment[]): string {
  return [
    'Address the review notes and commit.',
    commentNotes(comments),
    TOOLS
  ].join('\n')
}
