import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Store } from '../src/main/store'
import { TaskIssues } from '../src/main/tasks/task-issues'
import { callIssueTool, IssueToolServer } from '../src/main/issue-tools/server'
import type { Issue } from '../src/shared/valence'
import { onTestCleanup } from './test-cleanup'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-issue-tools-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const store = new Store(join(directory, 'config.json'), { migrationsFolder: resolve('src/main/db/migrations') })
  onTestCleanup(() => store.close())
  const issues = new TaskIssues(store)
  const addTask = (id: string) => {
    store.addProject({ id: 'project', name: 'Project', path: directory, createdAt: 1,
      monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
    store.addTask({ id, projectId: 'project', agentId: 'codex', agentLabel: 'Codex', title: id,
      prompt: 'Implement a change', cwd: directory, status: 'running', deliveryStatus: 'working', startedAt: 1,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
      filesChanged: 0, additions: 0, deletions: 0 })
    issues.initialize(id, directory)
  }
  addTask('task-a')
  const call = (taskId: string, name: string, input: unknown = {}) => callIssueTool(store, taskId, store.getTask(taskId)!.workspaceId, name, input)
  return { store, issues, addTask, call }
}
const input = { title: 'Change', description: 'Implement the change', checklist: ['Verify change'], validation: 'Run focused test' }

test('tools preserve ownership, dependency scheduling and developer review', () => {
  const { store, issues, addTask, call } = fixture()
  const first = call('task-a', 'anvil_create_issue', input) as Issue
  addTask('task-b')
  const other = call('task-b', 'anvil_create_issue', input) as Issue
  expect(() => call('task-a', 'anvil_update_issue', { id: other.id, patch: { title: 'Hijack' } })).toThrow(/another task/)
  expect(() => call('task-a', 'anvil_create_issue', { ...input, dependencies: [other.id] })).toThrow(/another task/)
  expect(() => call('task-a', 'anvil_create_issue', { ...input, parentId: other.parentId })).toThrow(/Unsupported/)
  expect(() => call('task-a', 'anvil_update_issue', { id: first.id, patch: { parentId: other.parentId } })).toThrow(/Unsupported/)
  const second = call('task-a', 'anvil_create_issue', { ...input, dependencies: [first.id] }) as Issue
  call('task-a', 'anvil_update_issue', { id: second.id, patch: { title: 'Dependent change' } })
  issues.finishPlanning('task-a')
  issues.claim('task-a')
  expect(() => call('task-a', 'anvil_create_issue', input)).toThrow(/planning/)
  expect(() => call('task-a', 'anvil_block_issue', { id: second.id })).toThrow(/current issue/)
  expect(() => call('task-a', 'anvil_submit_review', { id: first.id, checklist: [false], evidence: 'Failed' })).toThrow(/checklist/)
  expect(() => call('task-a', 'anvil_submit_review', { id: first.id, checklist: [true], evidence: '' })).toThrow(/evidence/)
  call('task-a', 'anvil_block_issue', { id: first.id })
  call('task-a', 'anvil_requeue_issue', { id: first.id })
  call('task-a', 'anvil_start_issue', { id: first.id })
  call('task-a', 'anvil_submit_review', { id: first.id, checklist: [true], evidence: 'Focused test passed' })
  expect(store.issueTracker('project').get(first.id).status).toBe('review')
  expect(() => call('task-a', 'anvil_approve_issue', { id: first.id })).toThrow(/Unknown/)
  expect(call('task-a', 'anvil_get_plan')).toMatchObject({ task: { id: 'task-a' }, issues: [expect.objectContaining({ id: first.id }), expect.objectContaining({ id: second.id })] })
})

test('MCP discovery and calls stay in the captured workspace and expire with the turn', async () => {
  const { store, addTask } = fixture()
  const changed: string[] = []
  const server = new IssueToolServer(store, (taskId) => changed.push(taskId))
  onTestCleanup(() => server.close())
  const connection = await server.open('task-a')
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  onTestCleanup(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }))
  const tools = await client.listTools()
  expect(tools.tools.map((tool) => tool.name)).toContain('anvil_get_plan')
  expect(tools.tools.some((tool) => /approve|delete|claim/.test(tool.name))).toBe(false)
  const work = store.createWorkspace('Work')
  store.selectWorkspace(work.id)
  addTask('task-b')
  const result = await client.callTool({ name: 'anvil_create_issue', arguments: input })
  expect(result.isError).not.toBe(true)
  expect(changed).toEqual(['task-a'])
  expect(store.issueTracker('project', 'default').list()).toHaveLength(1)
  expect(store.issueTracker('project', work.id).list()).toHaveLength(0)
  const otherConnection = await server.open('task-b')
  expect(otherConnection.headers).not.toEqual(connection.headers)
  expect((await fetch(connection.url, { method: 'POST' })).status).toBe(403)
  expect((await fetch(connection.url, { method: 'POST', headers: { ...connection.headers, Origin: 'https://example.com' } })).status).toBe(403)
  connection.close()
  expect((await fetch(connection.url, { method: 'POST', headers: connection.headers })).status).toBe(403)
  const resumed = await server.open('task-a')
  connection.close() // A stale cleanup must not disable the resumed turn.
  expect(resumed.headers).toEqual(connection.headers)
  const resumedClient = new Client({ name: 'resumed-agent', version: '1.0.0' })
  onTestCleanup(() => resumedClient.close())
  await resumedClient.connect(new StreamableHTTPClientTransport(new URL(resumed.url), { requestInit: { headers: resumed.headers } }))
  const plan = await resumedClient.callTool({ name: 'anvil_get_plan', arguments: {} })
  expect(plan.isError).not.toBe(true)
  expect(JSON.parse((plan.content as { text: string }[])[0].text).task.id).toBe('task-a')
  store.deleteTaskCascade('task-a')
  const deleted = await resumedClient.callTool({ name: 'anvil_get_plan', arguments: {} })
  expect(deleted.isError).toBe(true)
})
