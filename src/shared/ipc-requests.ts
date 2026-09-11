import type { TaskEventsRequest, AgentAccountTarget, AgentAccountConnect, TaskImageAttachment, PullRequestField, PullRequestPreview, RebaseStep, Settings, ComposerPreferences, WorkspacePreferences, TaskComment, TaskMergePreview } from './types'

/** The renderer supplies identities, never paths for privileged project actions. */
export interface IpcRequests {
  'wallpapers:directory': string | undefined
  'wallpapers:list': string | undefined
  'wallpapers:import': string | undefined
  'wallpapers:read': string | { workspaceId: string; id: string }
  'settings:get': string | undefined
  'settings:set': { workspaceId: string; patch: Partial<Settings> }
  'workspaces:list': undefined
  'workspaces:snapshot': undefined
  'workspaces:create': string
  'workspaces:rename': { workspaceId: string; name: string }
  'workspaces:select': string
  'workspaces:preferences:get': string
  'workspaces:preferences:set': { workspaceId: string; patch: Partial<WorkspacePreferences> }
  'workspaces:composer:import': ComposerPreferences
  'accounts:status': AgentAccountTarget
  'accounts:connect': AgentAccountConnect
  'accounts:disconnect': AgentAccountTarget
  'accounts:cancel': AgentAccountTarget & { sessionId: string }
  'agents:list': undefined
  'agents:models': { agentId: string; workspaceId?: string }
  'projects:list': undefined
  'projects:add': undefined
  'projects:update': { id: string; workspaceId?: string; monthlyTokenLimit?: number | null; monthlyCostLimitUsd?: number | null; finishOnPush?: boolean }
  'projects:remove': string
  'projects:reveal': string
  'projects:open-terminal': string
  'projects:git-status': string
  'projects:git-init': string
  'projects:branches': string
  'projects:files': { projectId: string }
  'projects:checkout': { projectId: string; branchName: string }
  'tasks:list': undefined
  'tasks:issues': string
  'tasks:events': string
  'tasks:events-page': TaskEventsRequest
  'tasks:diff': string
  'tasks:issue-diff': { taskId: string; issueId: string }
  'tasks:start': { parentTaskId?: string; workspaceId?: string; projectId: string; agentId: string; prompt: string; model?: string; reasoningEffort?: string; images?: TaskImageAttachment[]; fileReferences?: string[] }
  'tasks:steer': { taskId: string; message: string }
  'tasks:compact': string
  'tasks:stack': { taskId: string; parentTaskId: string }
  'tasks:stack-dismiss': string
  'tasks:restack': string
  'tasks:cancel': string
  'tasks:delete': string
  'tasks:settle': string
  'tasks:rebase': { taskId: string; steps: RebaseStep[] }
  'tasks:rebase-agent': string
  'tasks:merge-preview': string
  'tasks:approve': { taskId: string; preview: TaskMergePreview }
  'tasks:approve-issue': { taskId: string; issueId: string; headCommit: string | null }
  'tasks:reject-issue': { taskId: string; issueId: string; headCommit: string | null; comment?: string }
  'comments:list': string
  'comments:add': Pick<TaskComment, 'taskId' | 'file' | 'side' | 'lineNumber' | 'body'>
  'comments:remove': { taskId: string; id: string }
  'comments:send': string
  'github:credential-status': undefined
  'github:set-token': string
  'github:remove-token': undefined
  'github:pr-preview': string
  'github:open-pr': { taskId: string; preview: PullRequestPreview; title: string; description: string }
  'github:draft-pr-field': { taskId: string; field: PullRequestField; title: string; description: string }
  'github:open-pr-url': string
}

export type IpcChannel = keyof IpcRequests
export type IpcInvokeChannel = IpcChannel
export type IpcArgs<C extends IpcChannel> = undefined extends IpcRequests[C] ? [input?: IpcRequests[C]] : [IpcRequests[C]]
