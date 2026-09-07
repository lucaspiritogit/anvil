import assert from 'node:assert/strict'
import type { Issue } from 'valence'
import { planningPrompt, implementationPrompt } from '../src/main/agents/task-prompts'
import { taskIssueLabel } from '../src/shared/valence'

const task = 'Use the existing OpenAI SVG'
const issue: Issue = {
  id: '0123456789abcdef', title: 'Codex icon', description: 'Reuse public/providers/openai.svg',
  checklist: ['Show the SVG', 'Run validation'], validation: 'Run typecheck and check the composer',
  labels: ['frontend'], priority: 'medium', dependencies: [], status: 'working'
}
const planning = planningPrompt(task, 'task-one', '/projects/example')
const implementation = implementationPrompt(task, issue, '/projects/example')
assert.ok(planning.length < 1200, `Planning prompt should stay concise: ${planning.length} characters`)
assert.ok(implementation.length < 1300, `Implementation prompt should stay concise: ${implementation.length} characters`)
assert.match(planning, /Do not change project files/)
assert.match(planning, /1-50/)
assert.match(planning, /greetings/)
assert.match(planning, /no task issues means no work/)
assert.match(planning, /Create issues with vl/)
assert.ok(planning.includes(taskIssueLabel('task-one')))
assert.ok(!planning.includes(taskIssueLabel('task-two')))
assert.match(planning, /prerequisites first/)
assert.match(planning, /Leave the finished plan queued/)
assert.match(implementation, /already claimed/)
assert.match(implementation, /Complete it through vl/)
assert.match(implementation, /block it/)
assert.match(implementation, /evidence/)
for (const prompt of [planning, implementation]) {
  assert.ok(prompt.includes(task))
  assert.match(prompt, /vl --help/)
  assert.match(prompt, /vl --project "\/projects\/example"/)
  assert.match(prompt, /~\/\.config\/valence\//)
  assert.match(prompt, /not local storage/)
  assert.match(prompt, /Do not run init or use --local/)
  assert.match(prompt, /plain text/)
  assert.doesNotMatch(prompt, /task-result|noChanges/)
}
for (const detail of [issue.id, issue.description, issue.validation, ...issue.checklist]) {
  assert.ok(implementation.includes(detail), `Keep required issue context: ${detail}`)
}
console.log('Task prompts passed: CLI planning, task labels, project routing, plain-text responses, and persisted completion evidence.')
