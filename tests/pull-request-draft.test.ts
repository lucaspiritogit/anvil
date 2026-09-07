import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { AgentProcessManager } from '../src/main/agents/process-manager'
import type { AgentExecutor, TaskInput } from '../src/main/agents/agent-executor'
import { draftPullRequestField } from '../src/main/agents/pull-request-draft'
import type { Task, TaskDiff } from '../src/shared/types'

async function main(): Promise<void> {
  const inputs: TaskInput[] = []
  let output = 'Improve task review'
  let fail = false
  let closed = 0
  const executor: AgentExecutor = {
    async execute(input) {
      inputs.push(input)
      assert.equal(input.readOnly, true)
      assert.equal(input.resumeSessionId, undefined)
      assert.notEqual(input.cwd, process.cwd())
      assert.ok(existsSync(input.cwd))
      assert.equal(input.reasoningEffort, 'high')
      return { taskId: input.taskId, status: fail ? 'failed' : 'succeeded', error: fail ? 'Draft failed' : undefined, output, changedFiles: [] }
    },
    async close() { closed += 1 }
  }
  const manager = new AgentProcessManager(executor, executor)
  let lifecycleEvents = 0
  for (const name of ['event', 'exit', 'session', 'usage']) manager.on(name, () => { lifecycleEvents += 1 })
  const task = { id: 'task', agentId: 'codex', model: 'chosen-model', sessionId: 'original-session', prompt: 'Improve task review' } as Task
  const diff: TaskDiff = { patch: '+changed line', commits: [{ sha: 'commit', subject: 'Improve review' }] }
  try {
    assert.equal(await draftPullRequestField(manager, task, diff, 'title', 'Old title', 'Existing description', 'high'), output)
    assert.match(inputs[0].prompt, /only the GitHub pull request title/)
    assert.match(inputs[0].prompt, /\+changed line/)
    assert.equal(inputs[0].model, 'chosen-model')
    assert.equal(existsSync(inputs[0].cwd), false, 'Remove temporary drafting directories')
    output = '## Changes\nImprove the review layout.'
    assert.equal(await draftPullRequestField(manager, { ...task, agentId: 'opencode' }, diff, 'description', 'Edited title', '', 'high'), output)
    assert.match(inputs[1].prompt, /Edited title/)
    assert.notEqual(inputs[0].taskId, inputs[1].taskId)
    assert.equal(lifecycleEvents, 0, 'PR metadata must not restart or finalize the task')
    output = 'Invalid\nmultiline title'
    await assert.rejects(draftPullRequestField(manager, task, diff, 'title', '', '', 'high'), /invalid PR draft/)
    output = ' '
    await assert.rejects(draftPullRequestField(manager, task, diff, 'title', '', '', 'high'), /empty draft/)
    fail = true
    await assert.rejects(draftPullRequestField(manager, task, diff, 'description', '', '', 'high'), /Draft failed/)
    assert.ok(inputs.every((input) => !existsSync(input.cwd)), 'Cleanup also runs after failures')
    assert.equal(manager.isRunning(task.id), false)
    await manager.close()
    assert.ok(closed)
    await assert.rejects(draftPullRequestField(manager, task, diff, 'description', '', '', 'high'), /shutting down/)
    console.log('PR drafting passed: task agent/model, read-only fresh sessions, field prompts, isolated lifecycle, validation, and cleanup.')
  } finally {
    await manager.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
