import { expect, test } from 'vitest'
import { AgentTransportError, retryableAgentFailure } from '../src/main/agents/agent-failure'

test('recognizes recorded transient provider errors and structured Codex stream failures', () => {
  for (const message of [
    'Internal error: [Novita] deepseek/deepseek-v4.1-flash is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits',
    'Internal error: Cannot connect to API: The socket connection was closed unexpectedly.',
    'idle timeout waiting for websocket',
    'Service unavailable'
  ]) expect(retryableAgentFailure(new Error(message))).toEqual({ source: 'provider' })
  expect(retryableAgentFailure({ message: 'Stream failed', codexErrorInfo: { responseStreamDisconnected: {} } }))
    .toEqual({ source: 'provider' })
  expect(retryableAgentFailure(new AgentTransportError('Server exited'))).toEqual({ source: 'transport' })
})

test('preserves provider retry-after and rejects permanent or unknown failures', () => {
  expect(retryableAgentFailure({ message: 'Overloaded', statusCode: 503, responseHeaders: { 'retry-after': '45' } }))
    .toEqual({ source: 'provider', afterMs: 45_000 })
  expect(retryableAgentFailure({ message: 'Overloaded', data: { isRetryable: true, responseHeaders: { 'retry-after-ms': '2500' } } }))
    .toEqual({ source: 'provider', afterMs: 2500 })
  for (const message of [
    'Internal error: User not found.', 'Authenticate with codex login',
    'Rate limit: insufficient_quota, check billing', 'Invalid API key, retry later',
    'Context window exceeded', 'Unsupported model', 'Permission denied', 'Something failed'
  ]) expect(retryableAgentFailure(new Error(message))).toBeUndefined()
  expect(retryableAgentFailure({ message: 'Service unavailable', statusCode: 403 })).toBeUndefined()
  expect(retryableAgentFailure({ message: 'Rate limited', code: -32602 })).toBeUndefined()
})
