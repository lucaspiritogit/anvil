import type { TaskResult } from './agent-executor'

/** A broken local transport. The adapter must await server cleanup before retrying. */
export class AgentTransportError extends Error {}

export function agentTransportFailure(error: NodeJS.ErrnoException): Error {
  if (['EPIPE', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code ?? '')) {
    return new AgentTransportError(error.message)
  }
  return error
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** Classify terminal errors only, never tool failures or diagnostic notifications. */
export function retryableAgentFailure(error: unknown): TaskResult['retry'] {
  if (error instanceof AgentTransportError) return { source: 'transport' }
  const fields = object(error)
  const data = object(fields.data)
  const message = typeof fields.message === 'string' ? fields.message
    : typeof data.message === 'string' ? data.message : ''
  // Quota/auth/config failures need intervention even if the text mentions retries.
  if (/authenticat|unauthori[sz]ed|forbidden|api.?key|user not found|insufficient.quota|quota.exceeded|usage limit|credit|billing|context.length|context.window|invalid|unsupported|not supported/i.test(message)) return undefined
  const status = fields.statusCode ?? data.statusCode
  if (status === 401 || status === 403 || fields.code === -32602) return undefined
  const info = fields.codexErrorInfo
  const infoName = typeof info === 'string' ? info : Object.keys(object(info))[0]
  const transient = data.isRetryable === true || fields.isRetryable === true ||
    status === 429 || (typeof status === 'number' && status >= 500 && status <= 599) ||
    fields.code === -32001 ||
    ['responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(infoName ?? '') ||
    /rate[ -]limit|too many requests|temporarily unavailable|temporarily overloaded|server overloaded|service unavailable|bad gateway|gateway timeout|socket connection was closed|connection reset|ECONNRESET|ETIMEDOUT|EAI_AGAIN|idle timeout waiting for websocket|stream disconnected|stream.*closed unexpectedly/i.test(message)
  if (!transient) return undefined
  const headers = object(fields.responseHeaders ?? data.responseHeaders)
  const milliseconds = typeof headers['retry-after-ms'] === 'string' ? Number(headers['retry-after-ms']) : NaN
  const retryAfter = headers['retry-after']
  const seconds = Number(retryAfter)
  let afterMs: number | undefined
  if (Number.isFinite(milliseconds) && milliseconds >= 0) {
    afterMs = milliseconds
  } else if (typeof retryAfter === 'string' && Number.isFinite(seconds) && seconds >= 0) {
    afterMs = seconds * 1000
  } else if (typeof retryAfter === 'string') {
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) afterMs = Math.max(0, date - Date.now())
  }
  return { source: 'provider', ...(afterMs !== undefined ? { afterMs } : {}) }
}
