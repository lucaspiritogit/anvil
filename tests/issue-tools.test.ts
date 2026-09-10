import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Store } from '../src/main/store'
import { TaskIssues } from '../src/main/tasks/task-issues'
import { callIssueTool, IssueToolServer } from '../src/main/issue-tools/server'
import type { Issue } from '../src/shared/valence'
import { CodexAppServerClient } from '../src/main/agents/codex-app-server'
import { testWorkspace } from './workspace-fixture'
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
  for (const checklist of [[], [true, true], ['true']]) {
    expect(() => call('task-a', 'anvil_submit_review', { id: first.id, checklist, evidence: 'Passed' })).toThrow(/checklist/)
  }
  call('task-a', 'anvil_block_issue', { id: first.id })
  expect(() => call('task-a', 'anvil_submit_review', { id: first.id, checklist: [true], evidence: 'Passed' })).toThrow(/Only working/)
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
  const review = tools.tools.find((tool) => tool.name === 'anvil_submit_review')!
  expect(review.description).toContain('current issue in working status')
  expect(review.description).toContain('Success returns the issue in review status')
  expect(review.inputSchema.required).toEqual(['id', 'checklist', 'evidence'])
  expect(review.inputSchema.additionalProperties).toBe(false)
  expect(review.inputSchema.properties).toMatchObject({
    id: { type: 'string', description: expect.stringContaining('currentIssueId') },
    checklist: { type: 'array', items: { type: 'boolean' }, description: expect.stringContaining('Exactly one true confirmation') },
    evidence: { type: 'string', description: expect.stringContaining('commands run and their results') }
  })
  expect(review.inputSchema.properties?.checklist).toHaveProperty('description', expect.stringContaining('in the order'))

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
  const otherClient = new Client({ name: 'other-task', version: '1.0.0' })
  onTestCleanup(() => otherClient.close())
  await otherClient.connect(new StreamableHTTPClientTransport(new URL(otherConnection.url), { requestInit: { headers: otherConnection.headers } }))
  const otherIssueResult = await otherClient.callTool({ name: 'anvil_create_issue', arguments: input })
  const otherIssue = JSON.parse((otherIssueResult.content as { text: string }[])[0].text) as Issue
  const foreign = await client.callTool({ name: 'anvil_submit_review', arguments: { id: otherIssue.id, checklist: [true], evidence: 'Cannot submit another task' } })
  expect(foreign.isError).toBe(true)
  expect((foreign.content as { text: string }[])[0].text).toMatch(/not found|another task/i)

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

// The provider is fake; discovery, HTTP authorization, mutations and review gate are real.
for (const mode of ['fresh', 'resumed', 'planning-reuse', 'blocked-recovery', 'prose-only']) {
  test(`Codex app-server MCP review: ${mode}`, async () => {
    const { store, issues, call } = fixture()
    const task = store.getTask('task-a')!
    const issue = call('task-a', 'anvil_create_issue', input) as Issue
    const server = new IssueToolServer(store)
    onTestCleanup(() => server.close())
    const executor = new CodexAppServerClient({
      workspace: testWorkspace(), command: process.execPath,
      args: [resolve('tests/fixtures/codex-app-server.cjs'), mode === 'prose-only' ? 'success' : 'mcp-review', join(task.cwd, 'codex.jsonl')],
      requestTimeoutMs: 5000
    })
    onTestCleanup(() => executor.close())
    const execute = async (resumeSessionId?: string) => {
      const connection = await server.open(task.id)
      try {
        return await executor.execute({ workspace: testWorkspace(), taskId: task.id,
          cwd: task.cwd, prompt: 'Implement the issue', model: 'test-model',
          resumeSessionId, issueTools: connection }, () => {})
      } finally {
        connection.close()
        expect((await fetch(connection.url, { method: 'POST', headers: connection.headers })).status).toBe(403)
      }
    }
    let sessionId = mode === 'resumed' ? 'thread-test' : undefined
    if (mode === 'planning-reuse') {
      const planning = await execute()
      expect(planning.status, planning.error).toBe('succeeded')
      sessionId = planning.sessionId
      expect(store.issueTracker('project').get(issue.id).status).toBe('queued')
    }
    issues.finishPlanning(task.id)
    issues.claim(task.id)
    if (mode === 'blocked-recovery') call(task.id, 'anvil_block_issue', { id: issue.id })
    const result = await execute(sessionId)
    expect(result.status, result.error).toBe('succeeded')
    if (mode === 'prose-only') {
      expect(() => issues.finishIssue(task.id)).toThrow(/must submit.*anvil_submit_review/)
      expect(store.issueTracker('project').get(issue.id).status).toBe('working')
    } else {
      expect(store.issueTracker('project').get(issue.id)).toMatchObject({
        status: 'review', evidence: expect.stringContaining('node:assert/strict')
      })
      expect(issues.finishIssue(task.id)).toBe(true)
      expect(store.getTaskExecution(task.id)).toMatchObject({ phase: 'reviewing', currentIssueId: issue.id })
      expect(new TaskIssues(store).initialize(task.id, task.cwd).phase).toBe('reviewing')
    }
  })
}

// Explicit opt-in: uses an authenticated Codex profile and performs a live model turn.
test.skipIf(!process.env.ANVIL_LIVE_CODEX_HOME)('live Codex app-server commits and submits through MCP', async () => {
  const { store, issues, call } = fixture()
  const task = store.getTask('task-a')!
  const repo = join(task.cwd, 'smoke-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init')
  git('config', 'user.name', 'Anvil smoke')
  git('config', 'user.email', 'smoke@example.invalid')
  git('commit', '--allow-empty', '-m', 'chore: initialize smoke repository')
  const base = git('rev-parse', 'HEAD')
  const issue = call(task.id, 'anvil_create_issue', { title: 'Smoke review',
    description: 'Create smoke.txt containing ok, validate with node, commit and submit review.',
    checklist: ['smoke.txt contains ok and validation passed', 'Change committed'],
    validation: 'Run node to assert smoke.txt contains ok' }) as Issue
  issues.finishPlanning(task.id)
  issues.claim(task.id)
  const server = new IssueToolServer(store)
  onTestCleanup(() => server.close())
  const connection = await server.open(task.id)
  onTestCleanup(() => connection.close())
  const isolated = testWorkspace('live-smoke')
  const codexHome = process.env.ANVIL_LIVE_CODEX_HOME!
  const workspace = { ...isolated, codexHome, environment: { ...isolated.environment, CODEX_HOME: codexHome } }
  const executor = new CodexAppServerClient({ workspace, requestTimeoutMs: 30000 })
  onTestCleanup(async () => {
    try { await executor.close() } catch (error) {
      console.error('Live Codex cleanup failed:', error)
      throw error
    }
  })
  const account = await executor.readAccount()
  expect(account.account, 'Authenticated file-backed Codex profile required').toBeTruthy()
  const result = await executor.execute({ workspace, taskId: task.id, cwd: repo,
    issueTools: connection,
    prompt: 'Use the supplied anvil_issue_tracker MCP tools. Read anvil_get_plan for the current issue. Implement it in this disposable repository: write smoke.txt containing ok, run a node assertion to validate it, git add and git commit with a chore: subject. Then call anvil_submit_review with the current issue ID, ordered checklist confirmations and actual command/results evidence. Do not block or approve the issue. Stop after successful submission.'
  }, (event) => { if (event.type === 'output') process.stdout.write(event.event.text) })
  expect(result.status, result.error).toBe('succeeded')
  const head = git('rev-parse', 'HEAD')
  expect(head).not.toBe(base)
  expect(git('status', '--porcelain')).toBe('')
  expect(store.issueTracker('project').get(issue.id)).toMatchObject({ status: 'review', evidence: expect.stringContaining('node') })
  expect(issues.finishIssue(task.id, head)).toBe(true)
  expect(store.getTaskExecution(task.id)?.phase).toBe('reviewing')
  console.log('Live Codex smoke verified: committed', head, 'and persisted developer-review pause')
}, 180000)
