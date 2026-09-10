import { test, expect, beforeEach } from 'vitest'
import type { Issue, Task, TaskExecutionState } from '../src/shared/types'
import { planningPrompt, implementationPrompt, taskFollowupPrompt, taskRecoveryPrompt, issueReworkPrompt, reviewPrompt, agentRebasePrompt } from '../src/main/agents/task-prompts'

const task = 'Use the existing OpenAI SVG'
const issue: Issue = {
  id: '0123456789abcdef', parentId: 'parent-one', title: 'Codex icon', description: 'Reuse public/providers/openai.svg',
  checklist: ['Show the SVG', 'Run validation'], validation: 'Run typecheck and check the composer',
  labels: ['frontend'], priority: 'medium', dependencies: [], status: 'working'
}
const savedTask: Task = {
  workspaceId: 'default',
  id: 'task-one', projectId: 'project-one', agentId: 'opencode', agentLabel: 'OpenCode',
  prompt: task, title: task, cwd: '/projects/example', status: 'pending', startedAt: 0,
  inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
  deliveryStatus: 'working', filesChanged: 0, additions: 0, deletions: 0
}
const execution: TaskExecutionState = {
  taskId: savedTask.id, projectPath: savedTask.cwd, parentIssueId: issue.parentId,
  phase: 'working', issueIds: [issue.id], currentIssueId: issue.id, error: null
}
let planning: string
let implementation: string
beforeEach(() => {
  planning = planningPrompt(task, { projectPath: '/projects/example', parentIssueId: issue.parentId })
  implementation = implementationPrompt(task, issue, '/projects/example')
})

test('keeps planning concise and queues issues under the task parent', () => {
  expect(planning.length < 2400, `Planning prompt should stay concise: ${planning.length} characters`).toBeTruthy()
  expect(planning).toMatch(/Create issues for this task/)
  expect(planning).not.toContain(issue.parentId)
  expect(planning).not.toMatch(/anvil-task:/)
  expect(planning).toMatch(/prerequisites first/)
  expect(planning).toMatch(/Leave the finished plan queued/)
})

test('plans targeted checks without requiring a full-validation checkpoint', () => {
  for (const prompt of [planning]) {
    expect(prompt).toContain('Give each issue targeted validation commands')
    expect(prompt).not.toMatch(/full-suite|integration checkpoint|dedicated validation issue/)
    expect(prompt).toContain('Do not claim or implement issues')
  }
})

test('preserves review context without applying validation to history-only rebases', () => {
  const message = 'Fix the remaining bug'
  const comments = [{
    id: 'comment-one', taskId: savedTask.id, file: 'src/icon.tsx', side: 'additions' as const,
    lineNumber: 12, body: message, createdAt: 0, sentAt: null
  }]
  for (const prompt of [reviewPrompt(comments), issueReworkPrompt(savedTask.cwd, issue.id, comments)]) {
    expect(prompt).toContain(`src/icon.tsx:12 — ${message}`)
  }
  const rebase = agentRebasePrompt('base-commit')
  expect(rebase).toContain('git reset --soft base-commit')
  expect(rebase).toContain('Change no files: this is only a history operation')
  expect(rebase).not.toMatch(/targeted tests|full-suite validation/)
})

test('requires submitted review through anvil_submit_review and failure evidence', () => {
  expect(implementation.length < 2400, `Implementation prompt should stay concise: ${implementation.length} characters`).toBeTruthy()
  expect(implementation).toMatch(/already claimed/)
  expect(implementation).toMatch(/call anvil_submit_review/)
  expect(implementation).toMatch(/anvil_submit_review/)
  expect(implementation).toMatch(/anvil_block_issue/)
  expect(implementation).toMatch(/discovered MCP schema/)
  expect(implementation).toMatch(/developer review/)
})

test('recovery preserves task context and later user instructions without duplicating the plan', () => {
  const prompt = taskRecoveryPrompt(savedTask, execution)
  expect(prompt).toContain(savedTask.prompt)
  expect(prompt).not.toContain(execution.parentIssueId)
  expect(prompt).toContain(`Continue issue ${issue.id}`)
  expect(prompt).toContain('latest user instructions in the saved conversation')
  expect(prompt).toContain('If already submitted (review or done), report that result instead of repeating work')
  const planningRecovery = taskRecoveryPrompt(savedTask, { ...execution, phase: 'planning', currentIssueId: null })
  expect(planningRecovery).toContain('Leave the finished plan queued without implementing it')
  expect(planningRecovery).not.toContain('Continue issue')
})

test.each([
  ['planning', () => planning],
  ['implementation', () => implementation],
  ['automatic recovery', () => taskRecoveryPrompt(savedTask, execution)],
  ['issue rework', () => issueReworkPrompt(savedTask.cwd, issue.id, [])],
  ['task review', () => reviewPrompt([])]
] as const)('%s includes observable commands and scoped validation instructions once', (_name, buildPrompt) => {
  const prompt = buildPrompt()
  expect(prompt.match(/Keep long-running commands observable/g)).toHaveLength(1)
  expect(prompt).toContain('Do not pipe tests, builds, installs, or validation commands through tail')
  expect(prompt).toContain('tee')
  expect(prompt).toContain('pipefail')
  expect(prompt).toContain('Reading existing files or saved logs with tail is fine')
  expect(prompt).toContain('Use targeted tests and checks for the current issue or review changes')
  expect(prompt).not.toMatch(/full-suite|integration checkpoint/)
  expect(prompt).toContain('Honor required repository checks and issue validation; do not skip or weaken them')
})

test('routes both prompts through task-scoped tools and retains issue context', () => {
  for (const prompt of [planning, implementation]) {
    expect(prompt.includes(task)).toBeTruthy()
    expect(prompt).toContain('anvil_get_plan')
    expect(prompt).toContain('discovered MCP schema')
    expect(prompt).not.toContain('vl ')
    expect(prompt).not.toMatch(/~\/\.config|--local/)
    expect(prompt).toMatch(/plain text/)
    expect(prompt).not.toMatch(/task-result|noChanges/)
  }
  for (const detail of [issue.id, issue.description, issue.validation, ...issue.checklist]) {
    expect(implementation.includes(detail), `Keep required issue context: ${detail}`).toBeTruthy()
  }
})

test('tool guidance is phase-specific and keeps ownership out of arguments', () => {
  const rework = issueReworkPrompt(savedTask.cwd, issue.id, [])
  for (const prompt of [implementation, rework]) {
    expect(prompt).not.toMatch(/anvil_create_issue|anvil_update_issue|anvil_requeue_issue|anvil_start_issue/)
    expect(prompt).not.toContain(issue.parentId)
    expect(prompt).toContain('validating, and committing')
    expect(prompt).toContain('require a successful result')
    expect(prompt).toContain('Prose is never a review submission')
    expect(prompt).toContain('only the developer approves')
    expect(prompt).toContain('Do not claim or create other issues, or change issue ownership or dependencies')
  }
  for (const prompt of [planning, taskRecoveryPrompt(savedTask, { ...execution, phase: 'planning' })]) {
    expect(prompt).toContain('anvil_create_issue')
    expect(prompt).toContain('anvil_update_issue')
    expect(prompt).not.toMatch(/anvil_submit_review|anvil_start_issue/)
  }
  for (const prompt of [implementation, planning, rework]) {
    expect(prompt).toContain('available tool search/list facility')
    expect(prompt).not.toMatch(/checklist:|evidence:|mcp__/)
  }
})

test('interrupted guidance distinguishes blocked, queued, working and submitted issues', () => {
  for (const prompt of [taskRecoveryPrompt(savedTask, execution)]) {
    expect(prompt).toContain('If blocked, use anvil_requeue_issue then anvil_start_issue')
    expect(prompt).toContain('If queued, use anvil_start_issue')
    expect(prompt).toContain('If working, continue without requeueing')
    expect(prompt).toContain('If already submitted (review or done)')
    expect(prompt).toContain('require a successful result')
    expect(prompt).not.toMatch(/anvil_create_issue|anvil_update_issue/)
  }

})

test('follow-ups send a concise resume instruction and the developer message', () => {
  expect(taskFollowupPrompt(execution, 'Keep going')).toBe(`Resume issue ${issue.id}\n\nKeep going`)
  expect(taskFollowupPrompt({ ...execution, phase: 'planning', currentIssueId: null }, 'Continue'))
    .toBe('Resume task with anvil_get_plan\n\nContinue')
  expect(taskFollowupPrompt({ ...execution, phase: 'complete', currentIssueId: null }, 'Fix this'))
    .toBe('Fix this')
})
