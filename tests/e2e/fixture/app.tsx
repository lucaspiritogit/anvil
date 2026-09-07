import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Project, Task, TaskComment, TaskDiff, TaskEvent, TaskMergePreview, PullRequestPreview, PullRequestField } from '../../../src/shared/types'
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
  { ...base, id: 'review', title: 'Review sidebar changes', prompt: 'Keep the task list readable and preserve the existing keyboard shortcuts.', deliveryStatus: 'reviewable', reviewedAt: undefined, filesChanged: 2, additions: 3, deletions: 1, baseBranch: 'main', model: 'gpt-5' },
  base,
  { ...base, id: 'output', title: 'Layout test task', prompt: query.has('longPrompt') ? 'A long task description\n'.repeat(100) : 'Layout test task', projectId: projects[1].id, deliveryStatus: 'no_changes', reviewedAt: undefined, filesChanged: 0, additions: 0, deletions: 0 },
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
if (query.has('steering')) {
  tasks = tasks.map((task) => task.id === 'output' ? {
    ...task, sessionId: query.has('noSession') ? undefined : 'latest-session', model: 'task-model',
    ...(query.has('pending') ? { status: 'pending', deliveryStatus: 'agent_failed' } : {}),
    ...(query.has('running') ? { status: 'running', deliveryStatus: 'working', endedAt: undefined } : {}),
    ...(query.has('unsupported') ? { agentId: 'opencode', agentLabel: 'OpenCode' } : {})
  } : task)
}
if (query.has('cancelled')) {
  tasks = tasks.map((task) => task.id === 'failed' ? { ...task, status: 'cancelled' as const } : task)
}
tasks = tasks.map((task) => ({ ...task, branchName: `anvil/${task.id === 'approved' ? 'polish-task-cards' : task.id}` }))
const updates = new Set<(task: Task) => void>()
const update = (task: Task): Task => {
  tasks = tasks.map((item) => item.id === task.id ? task : item)
  updates.forEach((listener) => listener(task))
  return task
}
window.addEventListener('fixture:task-updated', (event) => update((event as CustomEvent<Task>).detail))
const reviewDiff: TaskDiff = {
  commits: [{ sha: '1234567890abcdef', subject: 'Update sidebar spacing' }, { sha: 'abcdef1234567890', subject: 'Document review behavior' }],
  patch: `diff --git a/src/sidebar.ts b/src/sidebar.ts
index 1111111..2222222 100644
--- a/src/sidebar.ts
+++ b/src/sidebar.ts
@@ -1,3 +1,4 @@
 export const sidebar = {
-  spacing: 8
+  spacing: 12,
+  showBranch: true
 }
diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Anvil
+Review the final task diff before approving.
`
}
let githubTokenConfigured = false
let comments: TaskComment[] = []
let diffRequests = 0
const events = (taskId: string): TaskEvent[] => {
  if (taskId === 'review') return [
    { id: 'review-user', taskId, ts: now - 2000, stream: 'system', kind: 'output', category: 'system', text: 'You:\nKeep existing keyboard shortcuts working.' },
    { id: 'review-agent', taskId, ts: now - 1000, stream: 'stdout', kind: 'output', category: 'message', text: 'The sidebar spacing is updated. Keyboard shortcuts are unchanged and the changes are ready for review.' }
  ]
  if (taskId !== 'output' || query.has('emptyOutput')) return []
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
      { id: 'codex', label: 'Codex', description: 'Codex agent', command: 'codex', args: [], defaultModel: 'gpt-5', supportsSteering: true },
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
  github: {
    credentialStatus: async () => ({ configured: githubTokenConfigured }),
    setToken: async () => {
      if (query.has('tokenFailure')) throw new Error('GitHub rejected the token')
      githubTokenConfigured = true
      return { configured: true }
    },
    removeToken: async () => { githubTokenConfigured = false; return { configured: false } },
    preview: async (taskId: string): Promise<PullRequestPreview> => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (query.has('prPreviewFailure')) throw new Error('Add your GitHub token in Settings.')
      return {
        sourceBranch: tasks.find((task) => task.id === taskId)!.branchName!, targetBranch: 'main',
        sourceCommit: 'source-head', targetCommit: 'local-head', remoteTargetCommit: 'remote-head',
        repository: 'developer/anvil', remote: 'origin', account: 'developer', commitCount: query.has('prEmpty') ? 0 : 3
      }
    },
    draftField: async (input: { taskId: string; field: PullRequestField; title: string; description: string }) => {
      window.dispatchEvent(new CustomEvent('fixture:pr-draft', { detail: input }))
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (query.has('prDraftFailure')) throw new Error('The agent could not draft PR text.')
      return input.field === 'title' ? 'Improve sidebar review' : '## Changes\nImprove sidebar spacing and document review behavior.'
    },
    openPullRequest: async (input: { taskId: string; preview: PullRequestPreview; title: string; description: string }) => {
      window.dispatchEvent(new CustomEvent('fixture:open-pr', { detail: input }))
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (query.has('prFailure')) throw new Error('The branch was pushed, but the PR could not be confirmed. Retry to check for an existing PR.')
      return {
        number: 42, url: 'https://github.com/developer/anvil/pull/42', title: input.title, description: input.description,
        author: 'developer', sourceBranch: input.preview.sourceBranch, targetBranch: input.preview.targetBranch, existing: query.has('prExisting')
      }
    },
    openUrl: async (url: string) => { window.dispatchEvent(new CustomEvent('fixture:pr-url', { detail: url })) }
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
    steer: async (input: { taskId: string; message: string }) => {
      window.dispatchEvent(new CustomEvent('fixture:steering', { detail: input }))
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (query.has('steerFailure')) throw new Error('The agent rejected steering')
      const task = tasks.find((task) => task.id === input.taskId)!
      update({ ...task, status: 'running', deliveryStatus: 'working', endedAt: undefined })
    },
    events: async (taskId: string) => events(taskId),
    diff: async () => {
      diffRequests += 1
      if (query.has('diffFailure') && diffRequests === 1) throw new Error('Could not load the task diff')
      return query.has('emptyDiff') ? { patch: '', commits: [] } : reviewDiff
    },
    mergePreview: async (taskId: string): Promise<TaskMergePreview> => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (query.has('mergePreviewFailure')) throw new Error('Check out a branch before approving')
      return {
        sourceBranch: tasks.find((task) => task.id === taskId)!.branchName!, targetBranch: 'user-current',
        sourceCommit: 'source-head', targetCommit: 'target-head', commitCount: Number(query.get('mergeCommitCount') ?? 3)
      }
    },
    approve: async (input: { taskId: string; preview: TaskMergePreview }) => {
      window.dispatchEvent(new CustomEvent('fixture:approval', { detail: input }))
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (query.has('mergeFailure')) throw new Error('Merge failed. The task was not approved.')
      return update({ ...tasks.find((task) => task.id === input.taskId)!, deliveryStatus: 'approved', reviewedAt: Date.now() })
    },
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
  comments: {
    list: async (taskId: string) => comments.filter((comment) => comment.taskId === taskId),
    add: async (input: Pick<TaskComment, 'taskId' | 'file' | 'side' | 'lineNumber' | 'body'>) => {
      comments = [...comments, { ...input, id: `comment-${comments.length}`, createdAt: now, sentAt: null }]
      return comments.filter((comment) => comment.taskId === input.taskId)
    },
    remove: async (input: { taskId: string; id: string }) => {
      comments = comments.filter((comment) => comment.id !== input.id)
      return comments.filter((comment) => comment.taskId === input.taskId)
    }
  },
  terminal: { ensure: noop, resize: noop, onData: subscribe, onExit: subscribe }
} as unknown as typeof window.anvil

const outputTaskId = query.get('task') ?? 'output'
const outputTask = tasks.find((task) => task.id === outputTaskId) ?? tasks.find((task) => task.id === 'output')!
if (query.get('scenario') === 'output') {
  useStore.setState({ activeProjectId: outputTask.projectId, view: { kind: 'task', taskId: outputTask.id } })
} else if (query.get('scenario') === 'review') {
  useStore.setState({ activeProjectId: projects[0].id, view: { kind: 'task', taskId: 'review' } })
}
const { App } = await import('../../../src/renderer/src/App')
createRoot(document.getElementById('root')!).render(<App />)
