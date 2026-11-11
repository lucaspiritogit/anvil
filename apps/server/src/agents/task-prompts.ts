import type { BranchSyncStatus, Issue, Task, TaskComment, TaskExecutionState, TaskMergeConflict } from '@anvil/protocol/types'
import { hasIssuePlan } from '@anvil/protocol/task-checkout'

const TOOLS = 'Use anvil_issue_tracker tools.'
export const BROWSER_TOOL_INSTRUCTION = "Use anvil_browser when the user asks to see, preview, or interact with the UI."

const FINISH_ISSUE = 'Commit finished work and call anvil_submit_review. Call anvil_block_issue if unfinished.'

export function planningPrompt(task: string, _state: Pick<TaskExecutionState, 'projectPath' | 'parentIssueId'>): string {
  return [
    'Decide how to handle this task.',
    'If it is a question, a small change or a single focused fix, do it directly now: answer, or make the change, validate it and commit it. Do not create issues.',
    'If it needs several separable steps, create a queued issue plan instead and do not implement it yet. Anvil runs the plan one issue at a time.',
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

export function localTaskPrompt(task: string): string {
  return [
    'Answer or complete the request directly in the current working directory in one turn.',
    'Do not create an issue plan or another worktree. Do not commit or push unless the request explicitly asks for it.',
    `Request: ${task}`
  ].join('\n')
}

export function taskFollowupPrompt(state: TaskExecutionState, message: string): string {
  if (!hasIssuePlan(state)) return localTaskPrompt(message)
  if (state.phase === 'complete') return message
  const instruction = state.currentIssueId ? `Resume issue ${state.currentIssueId}` : 'Resume task with anvil_get_plan'
  return `${instruction}\n\n${message}`
}

export function taskRecoveryPrompt(task: Task, state: TaskExecutionState): string {
  if (!hasIssuePlan(state)) {
    return [
      'Continue after the connection failure. Preserve completed work and follow the latest request.',
      localTaskPrompt(task.prompt)
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

export function withDiffNotes(message: string, comments: TaskComment[]): string {
  if (!comments.length) return message
  return [message, '', 'Notes on specific lines of the diff:', commentNotes(comments)].join('\n')
}

export function issueReworkPrompt(_projectPath: string, issueId: string, comments: TaskComment[]): string {
  return [
    `The developer reviewed issue ${JSON.stringify(issueId)}.`,
    commentNotes(comments),
    FINISH_ISSUE,
    TOOLS
  ].join('\n')
}

export function mergeConflictRepairPrompt(
  conflict: Pick<TaskMergeConflict, 'sourceBranch' | 'targetBranch' | 'requestedAction'>,
  unresolvedFiles: string[]
): string {
  const pushing = conflict.requestedAction === 'merge_and_push'
  return [
    'Repair the existing paused Git merge in this target project checkout.',
    `Source branch: ${JSON.stringify(conflict.sourceBranch)}`,
    `Target branch: ${JSON.stringify(conflict.targetBranch)}`,
    ...(pushing ? [`Anvil already pulled the latest ${JSON.stringify(conflict.targetBranch)} from origin before merging.`] : []),
    'Unresolved files:',
    ...unresolvedFiles.map((path) => `- ${JSON.stringify(path)}`),
    'Check for conflicts with `git status` and `git diff --name-only --diff-filter=U`, including any not listed above.',
    'Resolve every conflict while preserving the intended changes from both branches.',
    'Stage every resolved file and finish the existing merge with its current merge message.',
    ...(pushing ? [`Do not pull or push yourself. Anvil pushes ${JSON.stringify(conflict.targetBranch)} to origin once the merge is complete.`] : []),
    'Do not checkout or switch branches, reset, abort the merge, create another worktree, or change the task or issue status.',
    'Do not use Anvil issue-tracker tools during this repair.',
    'Leave the repository clean with the merge completed.'
  ].join('\n')
}

export interface ShipPull {
  sync: BranchSyncStatus
  keepUncommitted: boolean
}

export function shipInstructions(pull?: ShipPull): string {
  const lines = ['Ship this task\'s changes.']
  if (pull) {
    const { branch, behind, overlappingPaths } = pull.sync
    lines.push(
      `Pull origin/${branch} into ${branch}: it has ${behind} new commit${behind === 1 ? '' : 's'} that ${branch} does not have yet.`,
      ...(overlappingPaths.length ? [`Incoming changes touch: ${overlappingPaths.join(', ')}`] : []),
      'Merge them and resolve any conflicts so both the incoming code and this task\'s code keep working. Do not rebase or push.',
      pull.keepUncommitted
        ? 'Leave this task\'s changes uncommitted in the working tree; Anvil commits them after the pull.'
        : 'Commit the merge; Anvil merges the task branch and pushes after the pull.'
    )
  }
  lines.push(
    'Then write the commit message for the diff below: a subject line of at most 72 characters, optionally followed by a blank line and a short body, describing what the code changes and why.',
    'End with the commit message alone as your final reply.'
  )
  return lines.join('\n')
}

export function shipPrompt(patch: string, pull?: ShipPull): string {
  const limit = 60_000
  return [
    shipInstructions(pull),
    '```diff',
    patch.slice(0, limit),
    '```',
    ...(patch.length > limit ? ['The diff is truncated.'] : [])
  ].join('\n')
}

export function reviewPrompt(comments: TaskComment[]): string {
  return [
    'Address the review notes and commit.',
    commentNotes(comments),
    TOOLS
  ].join('\n')
}
