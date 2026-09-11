import { MIN_FONT_SIZE, MAX_FONT_SIZE, OVERVIEW_COLOR_PATTERN, WALLPAPER_ID_PATTERN } from '../../shared/appearance'
import { hasTaskContent, parseTaskImages } from '../../shared/task-images'
import { isOllamaBaseUrl } from '../../shared/memory-settings'
import type { IpcChannel, IpcRequests } from '../../shared/ipc-requests'

// Contracts only check representation. Existence, ownership and task state belong to handlers.
type Check<T> = (value: unknown, field: string) => T

function invalid(field: string, expected: string): never {
  throw new Error(`Invalid IPC request: ${field} ${expected}`)
}

function text(max: number, nonblank = true, pattern?: RegExp): Check<string> {
  return (value, field) => {
    if (typeof value !== 'string' || value.length > max || value.includes('\0') ||
      (nonblank && !value.trim()) || (pattern && !pattern.test(value))) {
      invalid(field, `must be ${nonblank ? 'nonempty ' : ''}text of at most ${max} characters in the expected format`)
    }
    return value
  }
}

function number(min: number, max = Number.MAX_SAFE_INTEGER, integer = true): Check<number> {
  return (value, field) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (integer && !Number.isSafeInteger(value))) invalid(field, `must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}`)
    return value
  }
}

const boolean: Check<boolean> = (value, field) => {
  if (typeof value !== 'boolean') invalid(field, 'must be a boolean')
  return value
}
const optional = <T>(check: Check<T>): Check<T | undefined> => (value, field) => value === undefined ? undefined : check(value, field)
const nullable = <T>(check: Check<T>): Check<T | null> => (value, field) => value === null ? null : check(value, field)
const oneOf = <T extends string>(...values: T[]): Check<T> => (value, field) => {
  if (!values.includes(value as T)) invalid(field, `must be one of ${values.join(', ')}`)
  return value as T
}
function object<T extends object>(shape: { [K in keyof T]-?: Check<T[K]> }): Check<T> {
  return (value, field) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(field, 'must be an object')
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(shape, key)) invalid(`${field}.${key}`, 'is not allowed')
    }
    const result: Record<string, unknown> = {}
    for (const [key, check] of Object.entries(shape) as [string, Check<unknown>][]) {
      const parsed = check(Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined, `${field}.${key}`)
      if (parsed !== undefined) result[key] = parsed
    }
    return result as T
  }
}
const array = <T>(check: Check<T>, max: number): Check<T[]> => (value, field) => {
  if (!Array.isArray(value) || !value.length || value.length > max) invalid(field, `must be an array of 1 to ${max} items`)
  // Array.from checks sparse slots too.
  return Array.from(value, (item, index) => check(item, `${field}[${index}]`))
}
const none: Check<undefined> = (value, field) => {
  if (value !== undefined) invalid(field, 'does not accept a payload')
  return undefined
}
const id = text(128, true, /^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const identifier = text(512, true, /^\S+$/)
const sha = text(64, true, /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
const branch = text(1024, true, /^(?!-)[^\s\x00-\x1f\x7f]+$/)
const file: Check<string> = (value, field) => {
  const path = text(4096)(value, field)
  if (/^[\\/]|^[a-z]:/i.test(path) || /[\x00-\x1f\x7f]/.test(path) || path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) {
    invalid(field, 'must be a relative diff file path')
  }
  return path
}
const mergePreview = {
  sourceBranch: branch, targetBranch: branch, sourceCommit: sha, targetCommit: sha, commitCount: number(0)
}

const settingsPatch = object<IpcRequests['settings:set']['patch']>({
  memoryEnabled: optional(boolean),
  memoryEmbeddingModel: optional(identifier),
  ollamaBaseUrl: optional((value, field) => {
    if (!isOllamaBaseUrl(value)) invalid(field, 'must be an HTTP or HTTPS base URL without credentials, query, or fragment')
    return value
  }),
  fontSize: optional(number(MIN_FONT_SIZE, MAX_FONT_SIZE)),
  overviewBackgroundMode: optional(oneOf('color', 'image')),
  overviewBackgroundColor: optional(text(7, true, OVERVIEW_COLOR_PATTERN)),
  overviewWallpaperId: optional(nullable(text(255, true, WALLPAPER_ID_PATTERN))),
  defaultAgentId: optional(id), defaultModel: optional(text(512, false)),
  autoCompactContext: optional(boolean), contextCompactionThreshold: optional(number(1, 100, true)),
  rebaseMode: optional(oneOf('manual', 'agent')), confirmRebase: optional(boolean), caffeineMode: optional(boolean),
  keybindings: optional(object({ toggleSidebar: text(128, false), focusTaskComposer: text(128, false) }))
})

const workspaceId = text(36, true, /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/)
const workspaceName = text(80, true, /^[^\x00-\x1f\x7f]+$/)
const stringRecord: Check<Record<string, string>> = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 2000) invalid(field, 'must be a string record')
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [text(1024, false)(key, field), text(1024, false)(entry, field)]))
}
const composer = object({ agentId: text(128, false), modelsByAgent: stringRecord, reasoningByAgentModel: stringRecord })

const contracts: { [C in IpcChannel]: Check<IpcRequests[C]> } = {
  'wallpapers:directory': optional(workspaceId),
  'wallpapers:list': optional(workspaceId),
  'wallpapers:import': optional(workspaceId),
  'wallpapers:read': (value, field) => typeof value === 'string'
    ? text(255, true, WALLPAPER_ID_PATTERN)(value, field)
    : object({ workspaceId, id: text(255, true, WALLPAPER_ID_PATTERN) })(value, field),
  'workspaces:list': none,
  'workspaces:snapshot': none,
  'workspaces:create': workspaceName,
  'workspaces:rename': object({ workspaceId, name: workspaceName }),
  'workspaces:select': workspaceId,
  'workspaces:preferences:get': workspaceId,
  'workspaces:preferences:set': object({ workspaceId, patch: object({ composer: optional(composer), lastProjectId: optional(nullable(id)) }) }),
  'workspaces:composer:import': composer,
  'settings:get': optional(workspaceId),
  'settings:set': object({ workspaceId, patch: settingsPatch }),
  'accounts:status': object({ workspaceId, agentId: oneOf('codex', 'opencode') }),
  'accounts:disconnect': object({ workspaceId, agentId: oneOf('codex', 'opencode') }),
  'accounts:cancel': object({ workspaceId, agentId: oneOf('codex', 'opencode'), sessionId: id }),
  'accounts:connect': (value, field) => {
    const input = object<IpcRequests['accounts:connect']>({ workspaceId, agentId: oneOf('codex', 'opencode'), method: oneOf('apiKey', 'chatgpt', 'native'), apiKey: optional(text(8192, true, /^[^\s]+$/)) })(value, field)
    if (input.agentId === 'codex' ? input.method === 'native' : input.method !== 'native') invalid(field, 'has an unsupported agent login method')
    if ((input.method === 'apiKey') !== (input.apiKey !== undefined)) invalid(field, 'requires a key only for API key login')
    return input
  },
  'agents:list': none,
  'agents:models': object({ agentId: id, workspaceId: optional(id) }),
  'projects:list': none,
  'projects:add': none,
  'projects:update': object({ id, workspaceId: optional(workspaceId), monthlyTokenLimit: optional(nullable(number(0))), monthlyCostLimitUsd: optional(nullable(number(0, Number.MAX_SAFE_INTEGER, false))), finishOnPush: optional(boolean) }),
  'projects:remove': id,
  'projects:reveal': id,
  'projects:open-terminal': id,
  'projects:git-status': id,
  'projects:git-init': id,
  'projects:branches': id,
  'projects:files': object({ projectId: id }),
  'projects:checkout': object({ projectId: id, branchName: text(1024) }),
  'tasks:list': none,
  'tasks:issues': id,
  'tasks:events': id,
  'tasks:diff': id,
  'tasks:issue-diff': object({ taskId: id, issueId: id }),
  'tasks:start': (value, field) => {
    const input = object<IpcRequests['tasks:start']>({ parentTaskId: optional(id), workspaceId: optional(id), projectId: id, agentId: id, prompt: text(100_000, false), model: optional(text(512, false)), reasoningEffort: optional(identifier), images: optional(parseTaskImages), fileReferences: optional(array(text(4096), 1000)) })(value, field)
    if (!hasTaskContent(input.prompt, input.images)) invalid(field, 'requires a prompt or an image')
    return input
  },
  'tasks:steer': object({ taskId: id, message: text(100_000) }),
  'tasks:compact': id,
  'tasks:stack': object({ taskId: id, parentTaskId: id }),
  'tasks:stack-dismiss': id,
  'tasks:restack': id,
  'tasks:cancel': id,
  'tasks:delete': id,
  'tasks:settle': id,
  'tasks:rebase': object({ taskId: id, steps: array(object({ sha, action: oneOf('pick', 'squash', 'drop'), message: text(100_000, false) }), 1000) }),
  'tasks:rebase-agent': id,
  'tasks:merge-preview': id,
  'tasks:approve': object({ taskId: id, preview: object(mergePreview) }),
  'tasks:approve-issue': object({ taskId: id, issueId: id, headCommit: nullable(id) }),
  'tasks:reject-issue': object({ taskId: id, issueId: id, headCommit: nullable(id), comment: optional(text(20_000)) }),
  'comments:list': id,
  'comments:add': object({ taskId: id, file, side: oneOf('additions', 'deletions'), lineNumber: number(1), body: text(20_000) }),
  'comments:remove': object({ taskId: id, id }),
  'comments:send': id,
  'github:credential-status': none,
  'github:set-token': text(1024),
  'github:remove-token': none,
  'github:pr-preview': id,
  'github:open-pr': object({ taskId: id, preview: object({
    ...mergePreview, repository: text(256, true, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), remote: oneOf('origin'), remoteTargetCommit: sha, account: id
  }), title: text(256), description: text(65_536, false) }),
  'github:draft-pr-field': object({ taskId: id, field: oneOf('title', 'description'), title: text(256, false), description: text(65_536, false) }),
  'github:open-pr-url': text(2048)
}

export function validateIpcRequest<C extends IpcChannel>(channel: C, args: unknown[]): IpcRequests[C] {
  if (args.length > 1) invalid(channel, 'accepts at most one payload')
  return contracts[channel](args[0], channel)
}
