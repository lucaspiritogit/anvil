import { onTestCleanup } from './test-cleanup'
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { SettingsProjectMemory } from '../src/main/memory/settings-project-memory'
import { createTaskMemory } from '../src/main/memory/task-memory'
import type { ProjectMemory } from '../src/main/memory/project-memory'
import type { TaskContext } from '../src/main/tasks/context'

test('gates memory access and discards retrieval when disabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-memory-settings-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const store = new Store(join(directory, 'test.db'), { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') })
  onTestCleanup(() => store.close())
  const calls: string[] = []
  let release: (() => void) | undefined
  let delayed = false
  const memory = new SettingsProjectMemory(() => store.getSettings(), (settings) => {
    calls.push(`create:${settings.memoryEmbeddingModel}:${settings.ollamaBaseUrl}`)
    const adapter: ProjectMemory = {
      connect: async () => { calls.push('connect') },
      recall: async () => {
        calls.push('recall')
        if (delayed) await new Promise<void>((resolve) => { release = resolve })
        return [{ content: 'Previous task context', similarity: 0.9 }]
      },
      rememberCompletedTask: async () => { calls.push('remember') },
      forgetProject: async () => { calls.push('forget') },
      close: async () => { calls.push('close') }
    }
    return adapter
  })
  onTestCleanup(() => memory.close())
  onTestCleanup(() => { release?.() })
  const taskMemory = createTaskMemory({ store, gitDelivery: {} as TaskContext['gitDelivery'] }, memory)
  try {
    expect(store.getSettings().memoryEnabled).toBe(false)
    store.addProject({ id: 'project', name: 'Test', path: directory, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
    const task = store.addTask({
      id: 'task', projectId: 'project', title: 'Memory', prompt: 'Fix icon', cwd: directory,
      agentId: 'codex', agentLabel: 'Codex', status: 'succeeded', deliveryStatus: 'reviewable', startedAt: 0,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
      filesChanged: 0, additions: 0, deletions: 0
    })
    await memory.connect()
    expect(await taskMemory.promptWithProjectMemory('project', 'New task')).toBe('New task')
    await taskMemory.rememberCompletedTask(task, directory)
    expect(calls, 'Disabled memory never initializes, recalls, or writes').toStrictEqual([])

    store.setSettings({ memoryEnabled: true })
    memory.settingsChanged()
    expect(await taskMemory.promptWithProjectMemory('project', 'New task')).toMatch(/Previous task context/)
    await taskMemory.rememberCompletedTask(task, directory)
    expect(calls).toStrictEqual(['create:mxbai-embed-large:http://localhost:11434/v1', 'connect', 'recall', 'remember'])

    delayed = true
    const pending = taskMemory.promptWithProjectMemory('project', 'No context after disabling')
    await expect.poll(() => release).toBeTypeOf('function')
    store.setSettings({ memoryEnabled: false })
    memory.settingsChanged()
    release!()
    expect(await pending, 'Disabling discards in-flight retrieval').toBe('No context after disabling')
    await memory.close()
    expect(calls.at(-1)).toBe('close')
    expect(await taskMemory.promptWithProjectMemory('project', 'Off')).toBe('Off')
  } finally {
    await memory.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('replaces the memory adapter after live model and URL changes', async () => {
  const store = new Store(':memory:', { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') })
  const changed: string[] = []
  const dynamic = new SettingsProjectMemory(() => store.getSettings(), (settings) => {
    changed.push(settings.memoryEmbeddingModel)
    return { connect: async () => {}, recall: async () => [], rememberCompletedTask: async () => {}, forgetProject: async () => {}, close: async () => { changed.push('closed') } }
  })
  onTestCleanup(() => dynamic.close())
  store.setSettings({ memoryEnabled: true })
  await dynamic.connect()
  store.setSettings({ memoryEmbeddingModel: 'custom-model', ollamaBaseUrl: 'http://127.0.0.1:11434/v1' })
  dynamic.settingsChanged()
  await dynamic.recall('project', 'query')
  expect(changed).toStrictEqual(['mxbai-embed-large', 'closed', 'custom-model'])
  await dynamic.close()
  expect(changed.at(-1)).toBe('closed')
})
