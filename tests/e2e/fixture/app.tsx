import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Project, Task, TaskEvent } from '../../../src/shared/types'
import { DEFAULT_KEYBINDINGS } from '../../../src/shared/keybindings'
import { canSettleTask } from '../../../src/shared/task-settlement'
import { useStore } from '../../../src/renderer/src/state/store'
import '../../../src/renderer/src/styles.css'

// Only the Electron bridge is replaced. Tests interact with the real App through Playwright.
const noop = () => {}
const subscribe = () => noop
const query = new URLSearchParams(location.search)
const now = Date.now()
const projects: Project[] = ['Anvil', 'Workbench'].map((name, index) => ({
  id: `project-${index}`, name, path: `/tmp/${name.toLowerCase()}`, createdAt: now,
  monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
}))
const base: Task = {
  id: 'approved', projectId: projects[0].id, title: 'Polish task cards', prompt: 'Polish task cards',
  agentId: 'codex', agentLabel: 'Codex', status: 'succeeded', deliveryStatus: 'approved',
  startedAt: now - 60 * 60 * 1000, endedAt: now - 30 * 60 * 1000, reviewedAt: now,
  inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, costUsd: 0,
  cwd: projects[0].path, filesChanged: 1, additions: 1, deletions: 0, branchName: 'anvil/polish-task-cards'
}
let tasks: Task[] = [
  { ...base, id: 'running', title: 'Build streaming support', prompt: 'Build streaming support', status: 'running', deliveryStatus: 'working', endedAt: undefined, reviewedAt: undefined },
  { ...base, id: 'review', title: 'Review sidebar changes', prompt: 'Review sidebar changes', deliveryStatus: 'reviewable', reviewedAt: undefined },
  base,
  { ...base, id: 'output', title: 'Layout test task', prompt: query.has('longPrompt') ? 'A long task description\n'.repeat(100) : 'Layout test task', projectId: projects[1].id, deliveryStatus: 'no_changes', reviewedAt: undefined },
  { ...base, id: 'failed', title: 'Retry provider setup', prompt: 'Retry provider setup', projectId: projects[1].id, status: 'failed', deliveryStatus: 'agent_failed', reviewedAt: undefined },
  { ...base, id: 'settled', title: 'Clean up old logs', prompt: 'Clean up old logs', settledAt: now - 60000 }
]
if (query.has('usage')) {
  tasks = tasks.map((task) => task.id === 'approved'
    ? { ...task, startedAt: now, inputTokens: 126268, outputTokens: 1759, totalTokens: 128027, costUsd: 12.34 }
    : task)
}
if (query.has('taskUsage')) {
  tasks = tasks.map((task) => task.id === 'output'
    ? { ...task, inputTokens: 688809, outputTokens: 3639, cachedTokens: 638208, totalTokens: 692448 }
    : task)
}
tasks = tasks.map((task) => ({ ...task, branchName: `anvil/${task.id === 'approved' ? 'polish-task-cards' : task.id}` }))
const updates = new Set<(task: Task) => void>()
const update = (task: Task): Task => {
  tasks = tasks.map((item) => item.id === task.id ? task : item)
  updates.forEach((listener) => listener(task))
  return task
}
window.addEventListener('fixture:task-updated', (event) => update((event as CustomEvent<Task>).detail))
const events = (taskId: string): TaskEvent[] => {
  if (taskId !== 'output') return []
  if (query.has('tools')) return [
    { id: 'tool-use:first', taskId, ts: 0, stream: 'stdout', kind: 'output', category: 'tool_use', text: 'Shell\npwd && rg --files' },
    { id: 'tool-result:first', taskId, ts: 1, stream: 'stdout', kind: 'output', category: 'tool_result', text: '/tmp/project\nfirst.ts\nsecond.ts' }
  ]
  return Array.from({ length: 300 }, (_, index) => ({
    id: String(index), taskId, ts: index, stream: 'stdout', kind: 'output', category: 'message',
    text: `Output ${index}: ${'long-token'.repeat(80)}`
  }))
}

window.anvil = {
  platform: query.get('platform') ?? 'linux',
  projects: { list: async () => projects, gitStatus: async () => ({ isRepository: true }) },
  agents: {
    list: async () => [
      { id: 'codex', label: 'Codex', description: 'Codex agent', command: 'codex', args: [], defaultModel: 'gpt-5' },
      { id: 'opencode', label: 'OpenCode', description: 'OpenCode agent', command: 'opencode', args: [], defaultModel: 'provider/model' }
    ],
    models: async (agentId: string) => query.has('reasoningModels') && agentId === 'opencode' ? {
      agentId,
      models: ['openrouter/deepseek/deepseek-v4', 'provider/reasoner', 'provider/plain'],
      reasoningByModel: {
        'openrouter/deepseek/deepseek-v4': { options: ['high', 'max'].map((id) => ({ id, label: id })) },
        'provider/reasoner': { options: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), default: 'medium' },
        'provider/plain': { options: [] }
      }
    } : {
      agentId, models: agentId === 'codex' ? ['gpt-5', 'gpt-5-mini'] : ['provider/model'],
      reasoningByModel: agentId === 'codex' ? Object.fromEntries(['gpt-5', 'gpt-5-mini'].map((model) => [model, {
        options: [{ id: 'native-max', label: 'Maximum reasoning' }, { id: 'high', label: 'High' }], default: 'high'
      }])) : { 'provider/model': { options: [] } }
    }
  },
  settings: { get: async () => ({ defaultAgentId: 'codex', defaultModel: '', rebaseMode: 'manual', confirmRebase: true, keybindings: DEFAULT_KEYBINDINGS }) },
  tasks: {
    list: async () => tasks,
    start: async (input: { projectId: string; agentId: string; prompt: string; model?: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (query.has('startFailure')) throw new Error('Task could not be started')
      const task: Task = {
        ...base, ...input, id: `started-${tasks.length}`, title: input.prompt,
        status: 'running', deliveryStatus: 'working', endedAt: undefined, reviewedAt: undefined,
        cwd: projects.find((project) => project.id === input.projectId)!.path
      }
      tasks = [task, ...tasks]
      return task
    },
    events: async (taskId: string) => events(taskId),
    onEvent: (listener: (event: TaskEvent) => void) => {
      const receive = (event: Event) => listener((event as CustomEvent<TaskEvent>).detail)
      window.addEventListener('fixture:output', receive)
      return () => window.removeEventListener('fixture:output', receive)
    },
    onUpdated: (listener: (task: Task) => void) => { updates.add(listener); return () => updates.delete(listener) },
    delete: async (taskId: string) => {
      if (query.has('deleteFailure')) throw new Error('Deletion failed for testing')
      tasks = tasks.filter((task) => task.id !== taskId)
    },
    settle: async (taskId: string) => {
      if (query.has('settleFailure')) throw new Error('Settlement failed for testing')
      const task = tasks.find((item) => item.id === taskId)!
      if (!canSettleTask(task)) throw new Error('Task is not eligible to settle')
      return update({ ...task, settledAt: Date.now() })
    }
  },
  comments: { list: async () => [] },
  terminal: { ensure: noop, resize: noop, onData: subscribe, onExit: subscribe }
} as unknown as typeof window.anvil

if (query.get('scenario') === 'output') {
  useStore.setState({ activeProjectId: projects[1].id, view: { kind: 'task', taskId: 'output' } })
}
const { App } = await import('../../../src/renderer/src/App')
createRoot(document.getElementById('root')!).render(<App />)
