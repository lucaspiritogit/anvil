const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const { spawn } = require('node:child_process')

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.288 (Claude Code)\n')
  process.exit(0)
}

const scenario = process.argv[2]
const transcript = process.argv[3]
const args = process.argv.slice(4)
const resumed = args.includes('--resume')
const sessionId = resumed ? args[args.indexOf('--resume') + 1] : `session-${process.pid}`
const baseline = resumed ? 1000 : 0
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const record = (entry) => appendFileSync(transcript, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
const usage = (extra = 0) => ({ fable: {
  inputTokens: baseline + extra, outputTokens: baseline + extra * 2,
  cacheReadInputTokens: baseline + extra * 3, cacheCreationInputTokens: baseline + extra * 4,
  costUSD: 25, contextWindow: 200000
} })
record({ event: 'spawn', cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR, args })

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  record({ message })
  if (message.type === 'control_request') {
    const request = message.request
    const reply = (response) => write({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id, response
    } })
    if (request.subtype === 'initialize') {
      if (scenario === 'missing-stderr' && resumed) {
        process.stderr.write(`No conversation found with session ID: ${sessionId}\n`)
        process.exit(1)
      }
      if (scenario === 'missing' && resumed) {
        process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution',
          is_error: true, errors: [`No conversation found with session ID: ${sessionId}`] })}\n`, () => process.exit(1))
        return
      }
      reply({ account: { apiProvider: scenario === 'api-provider' ? 'bedrock' : 'firstParty',
        tokenSource: scenario === 'api-auth' ? 'ANTHROPIC_API_KEY' : scenario === 'oauth-env' ? 'CLAUDE_CODE_OAUTH_TOKEN' : undefined,
        apiKeySource: scenario === 'api-auth' || scenario === 'api-key-auth' ? 'ANTHROPIC_API_KEY' : undefined,
        subscriptionType: scenario === 'subscription-metadata' ? undefined : scenario === 'subscription-display-name' ? 'Claude Max' : 'max' },
        models: [{ value: 'fable', displayName: 'Claude Fable 5', resolvedModel: 'claude-fable-5', supportsEffort: true, supportedEffortLevels: ['max', 'low', 'medium', 'high', 'xhigh'] },
          { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5', supportsEffort: false }, { value: 'disabled', disabled: true }] })
    } else if (request.subtype === 'get_usage') {
      reply({ session: { model_usage: usage() }, subscription_type: scenario === 'subscription-display-name' ? 'max' : 'team', rate_limits: null })
    } else if (request.subtype === 'mcp_status') {
      const configuration = JSON.parse(args[args.indexOf('--mcp-config') + 1])
      reply({ mcpServers: Object.keys(configuration.mcpServers).map((name) => ({ name,
        status: scenario === 'mcp-failed' ? 'failed' : 'connected' })) })
    } else if (request.subtype === 'get_context_usage') {
      reply({ totalTokens: 124, maxTokens: 200000 })
    } else if (request.subtype === 'interrupt') {
      reply({ still_queued: [], cancelled: [] })
    } else {
      write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Unsupported request' } })
    }
    return
  }
  if (message.type !== 'user') return
  write({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'queued', session_id: sessionId })
  write({ type: 'system', subtype: 'init', session_id: sessionId, capabilities: ['msg_lifecycle_v1', 'interrupt_cancel_queued_v1'] })
  if (scenario === 'hang' || scenario === 'partial-hang' || scenario === 'mixed' && message.message.content[0]?.text === 'Hang') {
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' })
    record({ childPid: descendant.pid })
    if (scenario === 'partial-hang') {
      write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'waiting' } } })
      write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
      write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Waiting' } } })
    } else {
      write({ type: 'assistant', session_id: sessionId, message: { id: 'waiting', content: [{ type: 'text', text: 'Waiting' }] } })
    }
    return
  }
  if (scenario === 'quota' || scenario === 'transient') {
    write({ type: 'result', subtype: 'error_during_execution', is_error: true,
      terminal_reason: scenario === 'quota' ? 'blocking_limit' : 'api_error', api_error_status: 429,
      errors: [scenario === 'quota' ? "You've hit your weekly limit" : 'Too many requests'], session_id: sessionId, modelUsage: usage(10) })
    return
  }
  if (message.message.content === '/compact') {
    if (scenario === 'compact-failed') {
      write({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Cannot compact this conversation', session_id: sessionId })
      write({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: sessionId, modelUsage: usage(10) })
      return
    }
    write({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId })
    write({ type: 'system', subtype: 'compact_boundary', uuid: 'compact', session_id: sessionId, compact_metadata: { trigger: 'manual', pre_tokens: 1000, post_tokens: 124 } })
    write({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sessionId })
    write({ type: 'result', subtype: 'success', is_error: false, local_command: 'compact', result: '', modelUsage: usage(10), session_id: sessionId })
    return
  }
  const id = `assistant-${process.pid}`
  write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id } } })
  write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } } })
  write({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, uuid: 'redacted', timestamp: '2026-10-04T16:00:00.000Z',
    message: { id, content: [{ type: 'redacted_thinking', data: 'opaque' }] } })
  write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } })
  write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } } })
  write({ type: 'stream_event', parent_tool_use_id: 'subagent', event: { type: 'message_start', message: { id: 'subagent' } } })
  write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Claude' } } })
  write({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, uuid: 'first-text', timestamp: '2026-10-04T16:00:01.000Z',
    message: { id, content: [{ type: 'text', text: 'Hello Claude' }] } })
  write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'edit', name: 'Edit', input: {} } } })
  write({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, uuid: 'edit-block', timestamp: '2026-10-04T16:00:02.000Z',
    message: { id, content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'file.ts' } }] } })
  write({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'Updated file.ts' }] } })
  write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } } })
  write({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'Second block' } } })
  const secondBlock = { type: 'assistant', parent_tool_use_id: null, session_id: sessionId, uuid: 'second-text', timestamp: '2026-10-04T16:00:03.000Z',
    message: { id, content: [{ type: 'text', text: 'Second block' }] } }
  write(secondBlock)
  write(secondBlock)
  write({ type: 'user', isReplay: true, session_id: sessionId, message: message.message })
  write({ type: 'result', subtype: 'success', is_error: false, result: 'Second block', stop_reason: 'end_turn',
    session_id: sessionId, modelUsage: usage(10), total_cost_usd: 25 })
})
