import Database from 'better-sqlite3'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import { CodexAppServerClient } from '../src/main/agents/codex-app-server'
import { OpenCodeAcpClient } from '../src/main/agents/opencode-acp'
import { resolveTaskWorkspace, resolveWorkspaceExecution } from '../src/main/agents/workspace-execution'
import { Store } from '../src/main/store'
import type { Task } from '../src/shared/types'
import { migrateBefore, migrationsFolder } from './migration-fixture'
import { openCodeWorkspaceFixture } from './opencode-workspace-fixture'
import { onTestCleanup } from './test-cleanup'

test('upgrades a legacy plan, runs both agents in both profiles and resumes their SQLite-owned sessions after restart', async () => {
  const fixture = await openCodeWorkspaceFixture()
  const database = join(fixture.directory, 'anvil.db')
  migrateBefore(database, 11)
  const legacy = new Database(database)
  try {
    legacy.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('project', 'Project', ?, 1)").run(fixture.project)
    legacy.prepare(`INSERT INTO tasks (id, project_id, agent_id, agent_label, prompt, title, cwd, status, started_at,
      session_id) VALUES ('legacy-task', 'project', 'codex', 'Codex', 'Legacy prompt', 'Legacy task', ?, 'succeeded', 1,
      'legacy-session')`).run(fixture.project)
    legacy.prepare("INSERT INTO settings VALUES ('fontSize', '18')").run()
    legacy.prepare("INSERT INTO parent_issues (id, anvil_task_id, title, description) VALUES ('legacy-plan', 'legacy-task', 'Saved plan', 'Keep this plan')").run()
  } finally {
    legacy.close()
  }

  const globalCodex = join(fixture.directory, 'global', '.codex')
  await mkdir(globalCodex, { recursive: true })
  const globalAuth = join(globalCodex, 'auth.json')
  await writeFile(globalAuth, '{"fixtureAccount":"global-account"}')
  vi.stubEnv('HOME', join(fixture.directory, 'global'))
  vi.stubEnv('CODEX_HOME', globalCodex)
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-global-key')

  const open = (): Store => {
    const store = new Store(database, { migrationsFolder })
    onTestCleanup(() => store.close())
    return store
  }
  let store = open()
  expect(store.getActiveWorkspace().id).toBe('default')
  expect(store.getSettings().fontSize).toBe(18)
  expect(store.getTask('legacy-task')).toMatchObject({ workspaceId: 'default', sessionId: 'legacy-session' })
  const profiles = [store.createWorkspace('Work'), store.createWorkspace('Personal')]
  const tasks: Task[] = []
  for (const [index, profile] of profiles.entries()) {
    expect(store.getSettings(profile.id).fontSize).toBe(14)
    expect(store.getTasks(profile.id)).toEqual([])
    store.addProject(store.getProjects('default')[0], profile.id)
    store.selectWorkspace(profile.id)
    store.setSettings({ fontSize: 15 + index, defaultAgentId: index === 0 ? 'codex' : 'opencode' })
    store.setWorkspacePreferences({ lastProjectId: 'project', composer: {
      agentId: index === 0 ? 'codex' : 'opencode',
      modelsByAgent: { codex: 'test-model', opencode: `openai/${profile.id}` }, reasoningByAgentModel: {}
    } })
    const workspace = resolveWorkspaceExecution(store, profile.id)
    await writeFile(join(workspace.codexHome, 'auth.json'), JSON.stringify({ fixtureAccount: profile.id }))
    await mkdir(join(workspace.environment.XDG_DATA_HOME!, 'opencode'), { recursive: true })
    await writeFile(join(workspace.environment.XDG_DATA_HOME!, 'opencode', 'auth.json'),
      JSON.stringify({ openai: { type: 'api', key: profile.id } }))
    for (const agentId of ['codex', 'opencode'] as const) {
      tasks.push(store.addTask({ id: `${profile.id}-${agentId}`, projectId: 'project', agentId,
        agentLabel: agentId, prompt: 'Implement the issue', title: `${profile.name} ${agentId}`,
        cwd: fixture.project, status: 'running', startedAt: 2, deliveryStatus: 'unavailable',
        inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
        filesChanged: 0, additions: 0, deletions: 0 }))
    }
  }

  for (const pass of ['initial', 'restart'] as const) {
    const clients: Array<CodexAppServerClient | OpenCodeAcpClient> = []
    const turns = tasks.map(async (original) => {
      const task = store.getTask(original.id)!
      // Deliberately keep the other profile selected during dispatch and resume.
      store.selectWorkspace(profiles.find((profile) => profile.id !== task.workspaceId)!.id)
      const workspace = resolveTaskWorkspace(store, task.id)
      const client = task.agentId === 'codex'
        ? new CodexAppServerClient({ workspace, command: process.execPath,
          args: [resolve('tests/fixtures/codex-app-server.cjs'), 'profile-success', join(fixture.directory, `${pass}-${task.id}.jsonl`)] })
        : new OpenCodeAcpClient({ workspace, command: fixture.command })
      clients.push(client)
      onTestCleanup(() => client.close())
      if (client instanceof CodexAppServerClient) {
        expect((await client.readAccount()).account).toMatchObject({ email: `${task.workspaceId}@example.invalid` })
      }
      const result = await client.execute({ taskId: task.id, workspace, cwd: task.cwd, prompt: task.prompt,
        model: store.getWorkspacePreferences(task.workspaceId).composer.modelsByAgent[task.agentId],
        resumeSessionId: pass === 'restart' ? task.sessionId : undefined
      }, () => {})
      expect(result.status, result.error).toBe('succeeded')
      expect(result.sessionId).toBeTruthy()
      if (pass === 'restart') expect(result.sessionId).toBe(task.sessionId)
      if (task.agentId === 'opencode') expect(result.output).toBe(task.workspaceId)
      store.updateTask(task.id, { status: 'succeeded', sessionId: result.sessionId })
    })
    await Promise.all(turns)
    expect(new Set(tasks.map((task) => store.getTask(task.id)!.sessionId)).size).toBe(4)
    await Promise.all(clients.map((client) => client.close()))
    store.selectWorkspace(profiles[1].id)
    store.close()
    store = open()
    expect(store.getActiveWorkspace().id).toBe(profiles[1].id)
    for (const [index, profile] of profiles.entries()) {
      expect(store.getSettings(profile.id).fontSize).toBe(15 + index)
      expect(store.getWorkspacePreferences(profile.id).lastProjectId).toBe('project')
      expect(store.getTasks(profile.id).map((task) => task.agentId).sort()).toEqual(['codex', 'opencode'])
    }
    expect(store.getTasks('default')).toHaveLength(1)
    expect(await readFile(globalAuth, 'utf8')).toBe('{"fixtureAccount":"global-account"}')
    await fixture.assertGlobalUnchanged()
  }
  const persisted = new Database(store.getWorkspaceDatabasePath('default'))
  try {
    expect(persisted.prepare('SELECT id, anvil_task_id, description FROM parent_issues').all()).toEqual([
      { id: 'legacy-plan', anvil_task_id: 'legacy-task', description: 'Keep this plan' }
    ])
    expect(persisted.pragma('foreign_key_check')).toEqual([])
  } finally {
    persisted.close()
  }
})
