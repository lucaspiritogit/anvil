import assert from 'node:assert/strict'
import { join } from 'node:path'
import { initializeTracker } from 'valence'
import { Store } from '../src/main/store'
import { registerIpc } from '../src/main/ipc'
import { handlers, testHome, AgentProcessManager } from './issue-tracker-doubles'

async function main(): Promise<void> {
  const store = new Store(join(testHome, '.anvil-composer/anvil.db'), {
    migrationsFolder: join(process.cwd(), 'src/main/db/migrations')
  })
  store.addProject({ id: 'project', name: 'Test', path: testHome, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const tracker = initializeTracker(testHome)
  const input = { title: 'Unrelated client work', description: 'Keep this outside the Anvil task', checklist: ['Verify'], validation: 'Run test', priority: 'urgent' as const }
  const unrelated = tracker.create(input)
  const { agentProcesses: processes } = registerIpc(() => null)
  const agentProcesses = processes as unknown as AgentProcessManager
  const task = await handlers.get('tasks:start')!(null, { projectId: 'project', agentId: 'codex', prompt: 'App change' })
  const tick = async (): Promise<void> => { for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve)) }
  await tick()
  agentProcesses.result(task.id, { items: [{ ...input, key: 'change', title: 'App change', labels: [], dependencies: [], priority: 'low' }] })
  await tick()
  const issue = tracker.list().find((entry) => entry.title === 'App change')
  assert.ok(issue, 'Anvil-created issues must be visible to another Valence client')
  assert.equal(issue.status, 'working')
  assert.equal(tracker.get(unrelated.id).status, 'queued', 'Anvil must not claim unrelated higher-priority issues')
  agentProcesses.result(task.id, { id: issue.id, status: 'complete', checklist: [true], evidence: 'Focused test passed' })
  await tick()
  assert.equal(tracker.get(issue.id).evidence, 'Focused test passed')
  assert.equal(store.getTask(task.id)?.status, 'succeeded')
  const removing = await handlers.get('tasks:start')!(null, { projectId: 'project', agentId: 'codex', prompt: 'Remove project' })
  await tick()
  agentProcesses.result(removing.id, { items: [{ ...input, key: 'removing' }] })
  await tick()
  const removingIssueId = store.getTaskExecution(removing.id)!.currentIssueId!
  await handlers.get('projects:remove')!(null, 'project')
  assert.equal(agentProcesses.isRunning(removing.id), false, 'Removing a project stops its Anvil agents')
  assert.equal(tracker.get(removingIssueId).status, 'blocked', 'Release only the removed project task claim')
  assert.equal(tracker.get(issue.id).status, 'complete', 'Project removal must preserve Valence history')
  assert.equal(tracker.get(unrelated.id).status, 'queued')
  tracker.close()
  store.close()
  console.log('Valence integration passed: shared state, scoped claims, completion, and final delivery.')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
