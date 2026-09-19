export interface BrowserToolConnectionData {
  url: string
  headers: Record<string, string>
}

export type BrowserHostRequest =
  | { type: 'anvil-browser-host-request'; requestId: string; operation: 'open'; taskId: string; title: string }
  | { type: 'anvil-browser-host-request'; requestId: string; operation: 'release'; taskId: string }

export type BrowserHostResponse =
  | { type: 'anvil-browser-host-response'; requestId: string; ok: true; connection?: BrowserToolConnectionData }
  | { type: 'anvil-browser-host-response'; requestId: string; ok: false; error: string }

export function isBrowserHostRequest(value: unknown): value is BrowserHostRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<BrowserHostRequest>
  if (request.type !== 'anvil-browser-host-request' || typeof request.requestId !== 'string' ||
    typeof request.taskId !== 'string' || !request.taskId) return false
  return request.operation === 'release' || request.operation === 'open' && typeof request.title === 'string'
}

export function isBrowserHostResponse(value: unknown): value is BrowserHostResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<BrowserHostResponse>
  return response.type === 'anvil-browser-host-response' && typeof response.requestId === 'string' &&
    (response.ok === true || response.ok === false && typeof response.error === 'string')
}
