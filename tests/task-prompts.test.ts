import { test, expect, beforeEach } from 'vitest'
import type { Issue, Task, TaskExecutionState } from '../src/shared/types'
import { planningPrompt, implementationPrompt, taskFollowupPrompt, issueReworkPrompt, reviewPrompt, agentRebasePrompt } from '../src/main/agents/task-prompts'

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
  expect(planning.includes(issue.parentId)).toBeTruthy()
  expect(planning).not.toMatch(/anvil-task:/)
  expect(planning).toMatch(/prerequisites first/)
  expect(planning).toMatch(/Leave the finished plan queued/)
})

test('plans targeted checks and an ordered full-suite integration checkpoint', () => {
  for (const prompt of [planning, taskFollowupPrompt(savedTask, { ...execution, phase: 'planning' }, 'Continue planning')]) {
    expect(prompt).toContain('Give each issue targeted validation commands')
    expect(prompt).toContain('last implementation issue or a dedicated validation issue')
    expect(prompt).toContain('dependencies on all implementation issues whose changes it validates')
    expect(prompt).toContain('Do not repeat full-suite requirements across every issue unless repository instructions require them')
    expect(prompt).toContain('Do not claim or implement issues')
  }
})

test('preserves follow-up and review context without applying validation to history-only rebases', () => {
  const message = 'Fix the remaining bug'
  expect(taskFollowupPrompt(savedTask, { ...execution, phase: 'complete' }, message)).toMatch(/Fix the remaining bug$/)
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

test('requires submitted review through vl and failure evidence', () => {
  expect(implementation.length < 2400, `Implementation prompt should stay concise: ${implementation.length} characters`).toBeTruthy()
  expect(implementation).toMatch(/already claimed/)
  expect(implementation).toMatch(/Submit it for review through vl/)
  expect(implementation).toMatch(/submit-review/)
  expect(implementation).toMatch(/block it/)
  expect(implementation).toMatch(/evidence/)
  expect(implementation).toMatch(/developer review/)
})

test.each([
  ['planning', () => planning],
  ['implementation', () => implementation],
  ['resumed planning', () => taskFollowupPrompt(savedTask, { ...execution, phase: 'planning' }, 'Continue planning')],
  ['resumed issue', () => taskFollowupPrompt(savedTask, execution, 'Continue implementation')],
  ['resumed scheduling', () => taskFollowupPrompt(savedTask, { ...execution, currentIssueId: null }, 'Unblock the plan')],
  ['completed-task follow-up', () => taskFollowupPrompt(savedTask, { ...execution, phase: 'complete' }, 'Fix the remaining bug')],
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
  expect(prompt).toContain('not by default after every issue')
  expect(prompt).toContain('Rerun if later changes invalidate that evidence')
  expect(prompt).toContain('Honor required repository checks and issue validation; do not skip or weaken them')
})

test('routes both prompts through the project CLI and retains issue context', () => {
  for (const prompt of [planning, implementation]) {
    expect(prompt.includes(task)).toBeTruthy()
    expect(prompt).toMatch(/vl --help/)
    expect(prompt).toMatch(/vl --project "\/projects\/example"/)
    expect(prompt).not.toMatch(/~\/\.config|--local/)
    expect(prompt).toMatch(/launcher selects the owning Anvil database/)
    expect(prompt).toMatch(/init only checks storage readiness/)
    expect(prompt).toMatch(/plain text/)
    expect(prompt).not.toMatch(/task-result|noChanges/)
  }
  for (const detail of [issue.id, issue.parentId, issue.description, issue.validation, ...issue.checklist]) {
    expect(implementation.includes(detail), `Keep required issue context: ${detail}`).toBeTruthy()
  }
})
