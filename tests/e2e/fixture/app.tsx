import React, { useState } from 'react'
import { useTaskIssues } from '../../../src/renderer/src/hooks/use-task-issues'
import { createRoot } from 'react-dom/client'
import type { Project, Task, TaskIssueSnapshot, TaskComment, TaskDiff, TaskEvent, TaskMergePreview, PullRequestPreview, PullRequestField, Settings, Wallpaper, ProviderModelList } from '../../../src/shared/types'
import { DEFAULT_KEYBINDINGS } from '../../../src/shared/keybindings'
import { canSettleTask } from '../../../src/shared/task-settlement'
import type { IpcRequests } from '../../../src/shared/ipc-requests'
import { useStore } from '../../../src/renderer/src/state/store'
import '@xterm/xterm/css/xterm.css'
import '../../../src/renderer/src/styles.css'

// Only the Electron bridge is replaced. Tests interact with the real App through Playwright.
const noop = () => {}
const subscribe = () => noop
const query = new URLSearchParams(location.search)
const now = Date.now()
let projects: Project[] = ['Anvil', 'Workbench'].map((name, index) => ({
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
const issueSnapshots: Record<string, TaskIssueSnapshot | null> = {}
window.addEventListener('fixture:issues', (event) => {
  const { taskId, snapshot } = (event as CustomEvent<{ taskId: string; snapshot: TaskIssueSnapshot | null }>).detail
  issueSnapshots[taskId] = snapshot
})
if (query.has('manyProjects')) {
  projects = [...projects, ...Array.from({ length: 150 }, (_, index) => ({
    ...projects[0], id: `extra-${index}`, name: index < 2 ? 'Duplicate' : `Project ${index}`,
    path: `/tmp/organization/${'long-directory/'.repeat(5)}repository-${index}`
  }))]
}
if (query.has('noProjects')) { projects = []; tasks = [] }
window.addEventListener('fixture:remove-project', (event) => {
  const id = (event as CustomEvent<string>).detail
  projects = projects.filter((project) => project.id !== id)
  window.dispatchEvent(new CustomEvent('fixture:projects-changed', { detail: projects }))
})
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

let settings: Settings = { memoryEnabled: false, memoryEmbeddingModel: 'mxbai-embed-large', ollamaBaseUrl: 'http://localhost:11434/v1', fontSize: 14, overviewBackgroundMode: 'color', overviewBackgroundColor: '#0d0f12', overviewWallpaperId: null, defaultAgentId: 'codex', defaultModel: '', rebaseMode: 'manual', confirmRebase: true, caffeineMode: false, keybindings: DEFAULT_KEYBINDINGS }

declare global {
  interface Window {
    fileMentionTest: { paths: Record<string, string[]>; delay: Record<string, number>; error: string | null; calls: string[] }
    composerTest: {
      starts: IpcRequests['tasks:start'][]
      failNextStart: boolean
      selectProject: (id: string) => void
      overview: () => void
    }
    wallpaperTest: { items: Wallpaper[]; reads: string[]; fail: boolean; loading: boolean }
    settingsTest: {
      apply: (patch: Partial<Settings>) => void
      calls: Partial<Settings>[]
      release: (reject?: boolean) => void
      finishLoading: () => void
    }
  }
}

window.wallpaperTest = { items: [], reads: [], fail: false, loading: false }
if (query.has('wallpapers')) {
  window.wallpaperTest.items = Array.from({ length: 31 }, (_, index) => ({
    id: `image-${index}.png`, name: `image-${index}.png`, width: 4, height: 3
  }))
}
if (query.has('appearance')) {
  settings.overviewBackgroundMode = 'image'
  settings.overviewBackgroundColor = '#123456'
  settings.overviewWallpaperId = 'image-0.png'
}
let releaseSettings: ((reject?: boolean) => void) | undefined
let finishLoading: () => void = noop
const settingsLoaded = new Promise<void>((resolve) => { finishLoading = resolve })
window.settingsTest = {
  apply: (patch) => { settings = { ...settings, ...patch }; useStore.setState({ settings }) },
  calls: [],
  release: (reject) => {
    if (!releaseSettings) throw new Error('No settings write is pending')
    const release = releaseSettings
    releaseSettings = undefined
    release(reject)
  },
  finishLoading
}
if (query.has('settingsLoading')) {
  settings.caffeineMode = true
  // Exercise a Settings modal mounted before the initial settings read finishes.
  useStore.setState({ ready: true, settingsOpen: true })
}

const projectBranches: Record<string, string> = Object.fromEntries(projects.map((project) => [project.id, 'main']))

window.fileMentionTest = {
  paths: {
    'project-0': ['src/TaskComposer.tsx', 'src/TaskCompletion.ts', 'src/main/index.ts', 'src/renderer/index.ts', 'docs/My notes 日本語.md', 'new-untracked.txt'],
    'project-1': ['workbench/OnlyHere.ts']
  }, delay: {}, error: null, calls: []
}
window.composerTest = {
  starts: [],
  failNextStart: false,
  selectProject: (id) => useStore.setState({ activeProjectId: id }),
  overview: () => useStore.setState({ view: { kind: 'home' } })
}

window.anvil = {
  platform: query.get('platform') === 'darwin' ? 'darwin' : query.get('platform') === 'win32' ? 'win32' : 'linux',
  projects: {
    files: async ({ projectId }: { projectId: string }) => {
      const fixture = window.fileMentionTest
      fixture.calls.push(projectId)
      const paths = [...(fixture.paths[projectId] ?? [])]
      const error = fixture.error
      await new Promise((resolve) => setTimeout(resolve, fixture.delay[projectId] ?? 0))
      return { projectId, paths: error ? [] : paths, source: 'git', truncated: false, warnings: [], error: error ? { code: 'unavailable', message: error } : null }
    },
    onChanged: (listener: (projects: Project[]) => void) => {
      const receive = (event: Event): void => listener((event as CustomEvent<Project[]>).detail)
      window.addEventListener('fixture:projects-changed', receive)
      return () => window.removeEventListener('fixture:projects-changed', receive)
    },
    list: async () => projects,
    add: async () => {
      const project: Project = {
        id: 'added-project', name: 'New project', path: '/tmp/new-project', createdAt: now,
        monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
      }
      projects = [...projects.filter((item) => item.id !== project.id), project]
      return project
    },
    remove: async (id: string) => {
      projects = projects.filter((project) => project.id !== id)
      tasks = tasks.filter((task) => task.projectId !== id)
      return projects
    },
    reveal: async () => '',
    gitStatus: async (id) => ({ isRepository: true, repoRoot: projects.find((project) => project.id === id)!.path, gitAvailable: true, pathExists: true }),
    gitInit: async (id) => window.anvil.projects.gitStatus(id),
    branches: async (projectId) => ({ currentBranch: projectBranches[projectId] ?? 'main', branches: [
      { name: 'main', checkedOut: (projectBranches[projectId] ?? 'main') === 'main' },
      { name: 'feature/composer', checkedOut: projectBranches[projectId] === 'feature/composer' },
      { name: 'task-running', checkedOut: true }
    ] }),
    checkout: async ({ projectId, branchName }) => {
      projectBranches[projectId] = branchName
      return window.anvil.projects.branches(projectId)
    },
    update: async ({ id, ...patch }: Partial<Project> & { id: string }) => Object.assign(projects.find((project) => project.id === id)!, patch)
  },
  agents: {
    list: async () => [
      { id: 'codex', label: 'Codex', description: 'Codex agent', command: 'codex', args: [], defaultModel: 'gpt-5', supportsSteering: true },
      { id: 'opencode', label: 'OpenCode', description: 'OpenCode agent', command: 'opencode', args: [], defaultModel: 'provider/model' }
    ],
    models: async (agentId: string): Promise<ProviderModelList> => query.has('composerModel') ? {
      agentId, models: [query.get('composerModel')!], reasoningByModel: {
        [query.get('composerModel')!]: { options: ['low', 'medium', 'high'].map((id) => ({ id, label: id })) }
      }
    } : query.has('reasoningModels') && agentId === 'opencode' ? {
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
  wallpapers: {
    directory: async () => '/test/.anvil-composer-dev/wallpaper',
    list: async () => {
      while (window.wallpaperTest.loading) await new Promise((resolve) => setTimeout(resolve, 20))
      if (window.wallpaperTest.fail) throw new Error('Folder unreadable')
      return [...window.wallpaperTest.items]
    },
    read: async (id: string) => {
      window.wallpaperTest.reads.push(id)
      return window.wallpaperTest.items.some((item) => item.id === id)
        ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' : null
    }
  },
  settings: {
    onChanged: () => noop,
    onOpenRequested: (listener: () => void) => {
      window.addEventListener('fixture:open-settings', listener)
      return () => window.removeEventListener('fixture:open-settings', listener)
    },
    get: async () => {
      if (query.has('settingsLoading')) await settingsLoaded
      return settings
    },
    set: async (patch: Partial<Settings>) => {
      window.settingsTest.calls.push(patch)
      if (query.has('settingsControlled')) {
        await new Promise<void>((resolve, reject) => {
          if (releaseSettings) throw new Error('Settings writes overlapped')
          releaseSettings = (fail) => fail ? reject(new Error('Settings write rejected')) : resolve()
        })
      }
      settings = { ...settings, ...patch }
      return settings
    }
  },
  tasks: {
    issues: async (taskId: string): Promise<TaskIssueSnapshot | null> => issueSnapshots[taskId] ?? null,
    list: async () => tasks,
    start: async (input: IpcRequests['tasks:start']) => {
      for (const path of input.fileReferences ?? []) {
        if (!window.fileMentionTest.paths[input.projectId]?.includes(path)) throw new Error(`Referenced file is missing or unavailable: ${JSON.stringify(path)}. Remove the reference or choose the file again.`)
      }
      window.composerTest.starts.push(input)
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (window.composerTest.failNextStart) {
        window.composerTest.failNextStart = false
        throw new Error('Task could not be started')
      }
      if (query.has('startFailure')) throw new Error('Task could not be started')
      const task: Task = {
        ...base, ...input, id: `started-${tasks.length}`, title: input.prompt || 'Image task',
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
    issueDiff: async ({ taskId, issueId }: { taskId: string; issueId: string }) => {
      window.dispatchEvent(new CustomEvent('fixture:issue-diff', { detail: { taskId, issueId } }))
      if (query.has('issueDiffFailure')) throw new Error('Could not load the subtask diff')
      return reviewDiff
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
    approveIssue: async (taskId: string) => {
      window.dispatchEvent(new CustomEvent('fixture:issue-approval', { detail: { taskId } }))
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (query.has('approveIssueFailure')) throw new Error('This task is not waiting for an issue review')
      return tasks.find((task) => task.id === taskId)!
    },
    rejectIssue: async (input: { taskId: string; comment?: string }) => {
      window.dispatchEvent(new CustomEvent('fixture:issue-rejection', { detail: input }))
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (query.has('rejectIssueFailure')) throw new Error('This task is not waiting for an issue review')
      return tasks.find((task) => task.id === input.taskId)!
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
    cancel: async (taskId) => {
      update({ ...tasks.find((task) => task.id === taskId)!, status: 'cancelled' })
      return true
    },
    rebase: async ({ taskId }) => tasks.find((task) => task.id === taskId)!,
    rebaseWithAgent: async (taskId) => tasks.find((task) => task.id === taskId)!,
    settle: async (taskId: string) => {
      if (query.has('settleFailure')) throw new Error('Settlement failed for testing')
      const task = tasks.find((item) => item.id === taskId)!
      if (!canSettleTask(task)) throw new Error('Task is not eligible to settle')
      return update({ ...task, settledAt: Date.now() })
    }
  },
  comments: {
    send: async (taskId) => {
      comments = comments.map((comment) => comment.taskId === taskId ? { ...comment, sentAt: Date.now() } : comment)
      return { task: tasks.find((task) => task.id === taskId)!, comments: comments.filter((comment) => comment.taskId === taskId) }
    },
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
  terminal: { ensure: async () => ({ data: '$ ', sequence: 0 }), write: noop, resize: noop, onData: subscribe, onExit: subscribe }
}

const outputTaskId = query.get('task') ?? 'output'
const outputTask = tasks.find((task) => task.id === outputTaskId) ?? tasks.find((task) => task.id === 'output')!
if (query.get('scenario') === 'output') {
  useStore.setState({ activeProjectId: outputTask.projectId, view: { kind: 'task', taskId: outputTask.id } })
} else if (query.get('scenario') === 'review') {
  useStore.setState({ activeProjectId: projects[0].id, view: { kind: 'task', taskId: 'review' } })
}
const { App } = await import('../../../src/renderer/src/App')
// Opt-in hook harness until the Issues panel is added. Existing scenarios use App.
function IssuesRefreshFixture(): React.JSX.Element {
  const [taskId, setTaskId] = useState('output')
  const [enabled, setEnabled] = useState(false)
  const issues = useTaskIssues(taskId, enabled, 'child')
  return <>
    <button onClick={() => setEnabled(!enabled)}>Toggle issues</button>
    <button onClick={() => setTaskId(taskId === 'output' ? 'approved' : 'output')}>Switch task</button>
    <button onClick={() => useStore.setState({ tasks: tasks.filter((task) => task.id !== taskId) })}>Delete task</button>
    <output aria-label="Issue snapshot">{JSON.stringify(issues)}</output>
  </>
}
if (query.has('issuesRefresh')) useStore.setState({ tasks })
createRoot(document.getElementById('root')!).render(query.has('issuesRefresh') ? <IssuesRefreshFixture /> : <App />)
