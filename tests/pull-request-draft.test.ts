import { testWorkspace } from './workspace-fixture'
import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { OpenCodeAcpClient } from '../src/main/agents/opencode-acp'
import { AgentProcessManager } from '../src/main/agents/process-manager'
import type { AgentExecutor, TaskInput } from '../src/main/agents/agent-executor'
import { draftPullRequestField } from '../src/main/agents/pull-request-draft'
import type { Task, TaskDiff } from '../src/shared/types'

test('drafts isolated read-only PR fields with validation, cleanup and real ACP sessions', async () => {
  const inputs: TaskInput[] = []
  let output = 'Improve task review'
  let fail = false
  let closed = 0
  const executor: AgentExecutor = {
    async execute(input) {
      inputs.push(input)
      expect(input.readOnly).toBe(true)
      expect(input.resumeSessionId).toBe(undefined)
      expect(input.cwd).not.toBe(process.cwd())
      expect(existsSync(input.cwd)).toBeTruthy()
      expect(input.reasoningEffort).toBe('high')
      return { taskId: input.taskId, status: fail ? 'failed' : 'succeeded', error: fail ? 'Draft failed' : undefined, output, changedFiles: [] }
    },
    async close() { closed += 1 }
  }
  const manager = new AgentProcessManager(executor, executor)
  onTestCleanup(() => manager.close())
  let lifecycleEvents = 0
  for (const name of ['event', 'exit', 'session', 'usage']) manager.on(name, () => { lifecycleEvents += 1 })
  const task = { workspaceId: 'default', id: 'task', agentId: 'codex', model: 'chosen-model', sessionId: 'original-session', prompt: 'Improve task review' } as Task
  const diff: TaskDiff = { patch: '+changed line', commits: [{ sha: 'commit', subject: 'Improve review' }] }
  try {
    expect(await draftPullRequestField(manager, testWorkspace(), task, diff, 'title', 'Old title', 'Existing description', 'high')).toBe(output)
    expect(inputs[0].prompt).toMatch(/only the GitHub pull request title/)
    expect(inputs[0].prompt).toMatch(/\+changed line/)
    expect(inputs[0].model).toBe('chosen-model')
    expect(existsSync(inputs[0].cwd), 'Remove temporary drafting directories').toBe(false)
    output = '## Changes\nImprove the review layout.'
    expect(await draftPullRequestField(manager, testWorkspace(), { ...task, agentId: 'opencode' }, diff, 'description', 'Edited title', '', 'high')).toBe(output)
    expect(inputs[1].prompt).toMatch(/Edited title/)
    expect(inputs[0].taskId).not.toBe(inputs[1].taskId)
    expect(lifecycleEvents, 'PR metadata must not restart or finalize the task').toBe(0)
    output = 'Invalid\nmultiline title'
    await expect(draftPullRequestField(manager, testWorkspace(), task, diff, 'title', '', '', 'high')).rejects.toThrow(/invalid PR draft/)
    output = ' '
    await expect(draftPullRequestField(manager, testWorkspace(), task, diff, 'title', '', '', 'high')).rejects.toThrow(/empty draft/)
    fail = true
    await expect(draftPullRequestField(manager, testWorkspace(), task, diff, 'description', '', '', 'high')).rejects.toThrow(/Draft failed/)
    expect(inputs.every((input) => !existsSync(input.cwd)), 'Cleanup also runs after failures').toBeTruthy()
    expect(manager.isRunning(task.id)).toBe(false)
    await manager.close()
    expect(closed).toBeTruthy()
    await expect(draftPullRequestField(manager, testWorkspace(), task, diff, 'description', '', '', 'high')).rejects.toThrow(/shutting down/)
    const directory = await mkdtemp(join(tmpdir(), 'anvil-pr-acp-test-'))
    onTestCleanup(() => rm(directory, { recursive: true, force: true }))
    const transcript = join(directory, 'requests.jsonl')
    const acp = new OpenCodeAcpClient({
      command: process.execPath, args: [resolve('tests/fixtures/opencode-acp.cjs'), 'read-only-config-draft', transcript], startupTimeoutMs: 5_000
    })
    onTestCleanup(() => acp.close())
    const actualManager = new AgentProcessManager(acp)
    onTestCleanup(() => actualManager.close())
    try {
      const openCodeTask = { ...task, agentId: 'opencode', model: 'provider/model' }
      expect(await draftPullRequestField(actualManager, testWorkspace(), openCodeTask, diff, 'title', '', '')).toBe('Improve task review')
      expect(await draftPullRequestField(actualManager, testWorkspace(), openCodeTask, diff, 'description', 'Improve task review', '')).toBe('Improve the review layout. Validation was not reported.')
      const requests = (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      expect(requests.filter((request) => request.method === 'session/new').length).toBe(2)
      expect(requests.some((request) => request.method === 'session/load')).toBe(false)
      expect(requests.filter((request) => request.params?.configId === 'mode' && request.params.value === 'plan').length).toBe(2)
      expect(requests.filter((request) => request.id === 'permission').every((request) => request.result.outcome.outcome === 'cancelled')).toBeTruthy()
    } finally {
      await actualManager.close()
      await rm(directory, { recursive: true, force: true })
    }
  } finally {
    await manager.close()
  }
})
