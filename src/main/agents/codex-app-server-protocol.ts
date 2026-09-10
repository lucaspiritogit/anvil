/**
 * The stable app-server subset Anvil uses, not ACP.
 * Reference: https://learn.chatgpt.com/docs/app-server
 * Checked against `codex app-server generate-ts` from codex-cli 0.153.4.
 * Extra response fields and unknown notifications are allowed for forward compatibility.
 */

export type CodexRequestId = number | string
export type CodexObject = Record<string, unknown>
export type CodexTurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed'

export interface CodexThreadOptions {
  cwd: string
  model?: string
  approvalPolicy: 'never'
  sandbox: 'danger-full-access' | 'read-only'
  config?: Record<string, boolean | number | string>
}

export interface CodexSandboxPolicy {
  type: 'dangerFullAccess' | 'readOnly'
}

export interface CodexTurn {
  id: string
  status: CodexTurnStatus
  items: CodexObject[]
  error?: { message: string; codexErrorInfo?: unknown } | null
}

export type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean }

export interface CodexAppServerRequests {
  'account/login/start': {
    params: { type: 'apiKey'; apiKey: string } | { type: 'chatgpt' }
    result: { type: 'apiKey' } | { type: 'chatgpt'; loginId: string; authUrl: string }
  }
  'account/login/cancel': { params: { loginId: string }; result: { status: string } }
  'account/logout': { params: Record<string, never>; result: CodexObject }
  'config/read': {
    params: { includeLayers: boolean }
    result: { config: CodexObject }
  }
  'account/read': {
    params: { refreshToken: boolean }
    result: { account: CodexAccount | null; requiresOpenaiAuth: boolean }
  }
  'model/list': {
    params: { cursor?: string | null; limit?: number | null; includeHidden?: boolean | null }
    result: {
      data: Array<{
        id: string
        model: string
        inputModalities?: string[]
        isDefault?: boolean
        supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
        defaultReasoningEffort: string
      }>
      nextCursor: string | null
    }
  }
  initialize: {
    params: { clientInfo: { name: string; title: string; version: string } }
    result: { userAgent: string }
  }
  'thread/start': {
    params: CodexThreadOptions
    result: { thread: { id: string } }
  }
  'thread/resume': {
    params: CodexThreadOptions & { threadId: string }
    result: { thread: { id: string } }
  }
  'turn/start': {
    params: {
      threadId: string
      input: Array<{ type: 'text'; text: string; text_elements: [] } | { type: 'image'; url: string }>
      cwd: string
      sandboxPolicy: CodexSandboxPolicy
    }
    result: { turn: CodexTurn }
  }
  'turn/steer': {
    params: {
      threadId: string
      expectedTurnId: string
      input: Array<{ type: 'text'; text: string; text_elements: [] }>
    }
    result: { turnId: string }
  }
  'turn/interrupt': {
    params: { threadId: string; turnId: string }
    result: CodexObject
  }
}

/** Typed request/response interface for Codex's bidirectional JSONL transport. */
export interface CodexAppServerProtocol {
  request<Method extends keyof CodexAppServerRequests>(
    method: Method,
    params: CodexAppServerRequests[Method]['params']
  ): Promise<CodexAppServerRequests[Method]['result']>
  initialized(): void
}

export function codexObject(value: unknown): CodexObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a Codex protocol object')
  return value as CodexObject
}

export function codexString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string in Codex protocol data')
  return value
}

export function codexId(value: unknown): string {
  const id = codexString(value)
  if (!id) throw new Error('Missing Codex thread, turn, or item ID')
  return id
}

export function codexTurn(value: unknown): CodexTurn {
  const turn = codexObject(value)
  if (!['inProgress', 'completed', 'interrupted', 'failed'].includes(String(turn.status))) {
    throw new Error(`Invalid Codex turn status: ${turn.status}`)
  }
  if (!Array.isArray(turn.items)) throw new Error('Expected Codex turn items')
  return {
    id: codexId(turn.id), status: turn.status as CodexTurnStatus,
    items: turn.items.map(codexObject),
    error: turn.error == null ? null : {
      message: codexString(codexObject(turn.error).message),
      codexErrorInfo: codexObject(turn.error).codexErrorInfo
    }
  }
}

export function validateCodexResponse(method: keyof CodexAppServerRequests, value: unknown): void {
  const result = codexObject(value)
  if (method === 'account/login/start') {
    if (result.type === 'chatgpt') { codexId(result.loginId); codexString(result.authUrl) }
    else if (result.type !== 'apiKey') throw new Error('Unsupported Codex login response')
  }
  if (method === 'account/login/cancel') codexString(result.status)
  if (method === 'config/read') codexObject(result.config)
  if (method === 'account/read') {
    if (typeof result.requiresOpenaiAuth !== 'boolean') throw new Error('Expected Codex authentication requirement')
    if (result.account !== null) {
      const account = codexObject(result.account)
      if (account.type === 'chatgpt') {
        if (account.email !== null) codexString(account.email)
        codexString(account.planType)
      } else if (account.type === 'amazonBedrock') {
        if (typeof account.usesCodexManagedCredentials !== 'boolean') throw new Error('Expected Codex credential ownership')
      } else if (account.type !== 'apiKey') {
        throw new Error('Unsupported Codex account type. Update Anvil to support this authentication method.')
      }
    }
  }
  if (method === 'model/list') {
    if (!Array.isArray(result.data)) throw new Error('Expected Codex model list')
    if (result.nextCursor !== null) codexString(result.nextCursor)
    for (const value of result.data) {
      const model = codexObject(value)
      codexId(model.id)
      codexId(model.model)
      if (model.inputModalities !== undefined && (!Array.isArray(model.inputModalities) || model.inputModalities.some((item) => typeof item !== 'string'))) {
        throw new Error('Expected Codex model input modalities')
      }
      codexString(model.defaultReasoningEffort)
      if (!Array.isArray(model.supportedReasoningEfforts)) throw new Error('Expected Codex reasoning options')
      for (const value of model.supportedReasoningEfforts) {
        const option = codexObject(value)
        codexId(option.reasoningEffort)
        codexString(option.description)
      }
    }
  }
  if (method === 'initialize') codexString(result.userAgent)
  if (method === 'thread/start' || method === 'thread/resume') codexId(codexObject(result.thread).id)
  if (method === 'turn/start') codexTurn(result.turn)
  if (method === 'turn/steer') codexId(result.turnId)
}
