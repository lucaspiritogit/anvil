import type { Issue, Task, TaskComment, TaskExecutionState } from '../../shared/types'
import { taskIssueLabel } from '../../shared/valence'

function trackerInstructions(projectPath: string): string {
  return `Use vl --project ${JSON.stringify(projectPath)} <command> for the original project's tracker, not local storage. Anvil initialized it; new trackers use ~/.config/valence/. Do not run init or use --local.`
}

export function planningPrompt(task: string, taskId: string, projectPath: string): string {
  return [
    'Plan this task as 1-50 focused Valence issues. Do not change project files or commit.',
    'Run `vl --help` to inspect commands. Create issues with vl; include findings, paths, checklists, validation, and priorities.',
    trackerInstructions(projectPath),
    `Label EVERY created issue ${JSON.stringify(taskIssueLabel(taskId))}. Create prerequisites first; dependencies use their actual issue IDs.`,
    'Leave the finished plan queued. Do not claim or implement issues. If planning fails, block any partial issues before exiting.',
    'For greetings or vague requests, reply briefly without tools or issues. A successful turn with no task issues means no work.',
    'Anvil reads the plan from Valence. Your final response is plain text. Prior memories are context only.',
    `Task: ${task}`
  ].join('\n')
}

export function implementationPrompt(task: string, issue: Issue, projectPath: string): string {
  const { id, title, description, checklist, validation } = issue
  return [
    'Implement this issue, validate it, and commit. Run `vl --help` to inspect Valence commands.',
    trackerInstructions(projectPath),
    'Anvil already claimed your issue. Complete it through vl only after satisfying its checklist; record actual validation evidence. If unfinished, block it and explain why in plain text.',
    'Do not claim or create other issues, change dependencies, or remove task labels.',
    'Install dependencies locally, without shared node_modules symlinks.',
    'Anvil reads completion from Valence, not your response. Summarize the outcome in plain text.',
    `Task: ${task}`,
    `Issue: ${JSON.stringify({ id, title, description, checklist, validation })}`
  ].join('\n')
}

export function taskFollowupPrompt(task: Task, state: TaskExecutionState, message: string): string {
  if (state.phase === 'complete') return message
  if (state.phase === 'planning') return [
    planningPrompt(task.prompt, task.id, state.projectPath),
    'The developer is unblocking an interrupted planning turn. Inspect existing task-labeled issues first; fix and requeue partial blocked issues instead of duplicating the plan.',
    `Developer message: ${message}`
  ].join('\n\n')
  return [
    'The developer is unblocking this task. Keep its existing plan and branch.',
    trackerInstructions(state.projectPath),
    `Original task: ${task.prompt}`,
    `Task issue IDs: ${state.issueIds.join(', ')}`,
    state.currentIssueId
      ? `Resume issue ${state.currentIssueId}. Inspect its status, requeue and start it if blocked, then implement, validate, commit, and complete it through vl. If still working, verify it belongs to this interrupted task before requeueing. Do not take over another client's work.`
      : 'Inspect and unblock the remaining task issues so Anvil can schedule them. Leave unfinished issues queued; do not claim new work.',
    'Do not create a replacement plan or claim other issues. Anvil checks Valence completion and runs the remaining issues in order.',
    `Developer message: ${message}`
  ].join('\n\n')
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
  const notes = comments
    .map((comment) => `${comment.file}:${comment.lineNumber} — ${comment.body}`)
    .join('\n')
  return [
    'The developer reviewed your changes and left the notes below.',
    'Address each one in the code, then commit.',
    '',
    notes
  ].join('\n')
}
