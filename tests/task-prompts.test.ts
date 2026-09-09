import { test, expect, beforeEach } from 'vitest'
import type { Issue } from '../src/shared/valence'
import { planningPrompt, implementationPrompt } from '../src/main/agents/task-prompts'

const task = 'Use the existing OpenAI SVG'
const issue: Issue = {
  id: '0123456789abcdef', parentId: 'parent-one', title: 'Codex icon', description: 'Reuse public/providers/openai.svg',
  checklist: ['Show the SVG', 'Run validation'], validation: 'Run typecheck and check the composer',
  labels: ['frontend'], priority: 'medium', dependencies: [], status: 'working'
}
let planning: string
let implementation: string
beforeEach(() => {
  planning = planningPrompt(task, { projectPath: '/projects/example', parentIssueId: issue.parentId })
  implementation = implementationPrompt(task, issue, '/projects/example')
})

test('keeps planning concise and queues issues under the task parent', () => {
  expect(planning.length < 750, `Planning prompt should stay concise: ${planning.length} characters`).toBeTruthy()
  expect(planning).toMatch(/Create issues for this task/)
  expect(planning.includes(issue.parentId)).toBeTruthy()
  expect(planning).not.toMatch(/anvil-task:/)
  expect(planning).toMatch(/prerequisites first/)
  expect(planning).toMatch(/Leave the finished plan queued/)
})

test('requires submitted review through vl and failure evidence', () => {
  expect(implementation.length < 1200, `Implementation prompt should stay concise: ${implementation.length} characters`).toBeTruthy()
  expect(implementation).toMatch(/already claimed/)
  expect(implementation).toMatch(/Submit it for review through vl/)
  expect(implementation).toMatch(/submit-review/)
  expect(implementation).toMatch(/block it/)
  expect(implementation).toMatch(/evidence/)
  expect(implementation).toMatch(/developer review/)
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
