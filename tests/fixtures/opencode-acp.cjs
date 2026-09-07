const { createInterface } = require('node:readline')
const { appendFileSync, realpathSync } = require('node:fs')

const [scenario, transcript] = process.argv.slice(2)
if (scenario === 'cancel-hang') process.on('SIGTERM', () => {})
const sessionId = 'session-test'
let promptId
let initialized = false
let modelSelected = false
const effortConfig = (values) => [{
  id: 'effort', name: 'Thinking level', category: 'thought_level', type: 'select',
  currentValue: values[0], options: values.map((value) => ({ value, name: value }))
}]
const sessionConfig = () => ['limited-effort', 'removed-effort'].includes(scenario)
  ? effortConfig(['medium'])
  : scenario === 'session-effort' ? effortConfig(['high', 'medium']) : []
const selectedConfig = () => scenario === 'limited-effort' ? effortConfig(['high'])
  : scenario === 'native-effort' ? effortConfig(['high', 'max'])
  : scenario === 'grouped-effort' ? [{ ...effortConfig(['high', 'medium'])[0], options: [{
    group: 'reasoning', name: 'Reasoning', options: effortConfig(['high', 'medium'])[0].options
  }] }]
    : scenario === 'rejected-effort' ? effortConfig(['medium']) : []
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const respond = (id, result) => send({ id, result })
const update = (update, id = sessionId) => send({ method: 'session/update', params: { sessionId: id, update } })
const text = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

function finish() {
  if (scenario === 'refusal') return respond(promptId, { stopReason: 'refusal' })
  if (scenario === 'max-tokens') return respond(promptId, { stopReason: 'max_tokens' })
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Think' } })
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ing\n' } })
  update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read source', kind: 'read', status: 'completed', locations: [{ path: '/read-only.ts' }] })
  update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit source', kind: 'edit', status: 'in_progress', locations: [{ path: '/changed.ts' }], content: [{ type: 'diff', path: '/changed.ts', oldText: 'old', newText: 'new' }] })
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' })
  update({ sessionUpdate: 'tool_call', toolCallId: 'failed', title: 'Failed edit', kind: 'edit', status: 'failed', locations: [{ path: '/failed.ts' }] })
  update({ sessionUpdate: 'tool_call', toolCallId: 'test', title: 'Run tests', kind: 'execute', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Tests passed' } }] })
  update({ sessionUpdate: 'plan', entries: [{ content: 'Implement issue', priority: 'high', status: 'completed' }] })
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wrong session' } }, 'other-session')
  const output = 'Done ✓\nCompleted issue-test through vl. Tests passed.'
  // Model deltas can split anywhere in the final summary.
  for (const character of output) text(character)
  update({ sessionUpdate: 'usage_update', used: 9999, size: 100000, cost: { amount: 0.25, currency: 'USD' } })
  process.stderr.write('diagnostic\ntrailing diagnostic')
  respond(promptId, { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 35, cachedReadTokens: 5 } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync(transcript, JSON.stringify(message) + '\n')
  if (message.id === 'permission') {
    const outcome = message.result.outcome
    if (scenario === 'deny-only') {
      if (outcome.outcome !== 'cancelled') process.exit(7)
    } else if (outcome.optionId !== 'once') process.exit(8)
    finish()
    return
  }
  if (message.method === 'initialize') {
    if (scenario === 'startup-hang') return
    initialized = true
    respond(message.id, { protocolVersion: scenario === 'version' ? 999 : 1, agentCapabilities: { loadSession: scenario !== 'no-resume' } })
  } else if (message.method === 'session/new' || message.method === 'session/load') {
    if (!initialized || realpathSync(message.params.cwd) !== process.cwd() || realpathSync(process.env.PWD) !== process.cwd()) process.exit(9)
    if (message.method === 'session/load') {
      text('Old turn summary from history.')
      update({ sessionUpdate: 'tool_call', toolCallId: 'old', title: 'Old edit', kind: 'edit', status: 'completed', locations: [{ path: '/old.ts' }] })
    }
    respond(message.id, { sessionId, configOptions: sessionConfig() })
  } else if (message.method === 'session/set_config_option') {
    if (message.params.configId === 'effort') {
      const config = modelSelected ? selectedConfig() : sessionConfig()
      const values = config.flatMap((option) => option.options).flatMap((option) => option.options ?? [option]).map((option) => option.value)
      if (!values.includes(message.params.value) || scenario === 'rejected-effort') {
        return send({ id: message.id, error: {
          code: -32602, message: `Invalid params: effort not found: ${message.params.value}`,
          data: { effort: message.params.value }
        } })
      }
      return respond(message.id, { configOptions: config })
    }
    const expectedModel = scenario === 'openrouter' ? 'openrouter/anthropic/claude-sonnet-4-6' : 'provider/model'
    if (message.params.configId !== 'model' || message.params.value !== expectedModel) process.exit(10)
    modelSelected = true
    respond(message.id, { configOptions: selectedConfig() })
  } else if (message.method === 'session/prompt') {
    promptId = message.id
    if ((!modelSelected && scenario !== 'session-effort') || message.params.prompt[0].text !== 'Implement the issue') process.exit(11)
    if (scenario === 'exit') return process.exit(3)
    if (scenario === 'orphan') {
      require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
      return process.exit(3)
    }
    if (scenario === 'malformed') {
      process.stdout.write('not json\n')
      return setTimeout(() => process.exit(4), 30)
    }
    if (scenario === 'rpc-error') return send({ id: message.id, error: { code: -32603, message: 'Provider authentication failed' } })
    if (scenario.startsWith('cancel')) {
      text(scenario === 'cancel-partial' ? 'Waiting' : 'Waiting\n')
      return
    }
    send({ id: 'permission', method: 'session/request_permission', params: {
      sessionId, toolCall: { toolCallId: 'edit', title: 'Edit source' },
      options: scenario === 'deny-only'
        ? [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
        : [{ optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'once', name: 'Once', kind: 'allow_once' }]
    } })
  } else if (message.method === 'session/cancel' && ['cancel', 'cancel-partial'].includes(scenario)) {
    respond(promptId, { stopReason: 'cancelled' })
    if (scenario === 'cancel-partial') setTimeout(() => text('Late chunk after cancellation'), 10)
  }
})
