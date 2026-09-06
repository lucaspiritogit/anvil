const { createInterface } = require('node:readline')
const { appendFileSync, realpathSync } = require('node:fs')

const [scenario, transcript] = process.argv.slice(2)
if (scenario === 'cancel-hang') process.on('SIGTERM', () => {})
const sessionId = 'session-test'
let promptId
let initialized = false
let modelSelected = false
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
  const output = 'Done ✓\n<anvil-issue-tracker>{"id":"issue-test","status":"complete","checklist":[true],"evidence":"Tests passed"}</anvil-issue-tracker>'
  // Model deltas can split anywhere, including inside JSON strings and tag names.
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
      text('<anvil-issue-tracker>{"old":"history"}</anvil-issue-tracker>')
      update({ sessionUpdate: 'tool_call', toolCallId: 'old', title: 'Old edit', kind: 'edit', status: 'completed', locations: [{ path: '/old.ts' }] })
    }
    respond(message.id, { sessionId, configOptions: [] })
  } else if (message.method === 'session/set_config_option') {
    if (message.params.configId !== 'model' || message.params.value !== 'provider/model') process.exit(10)
    modelSelected = true
    respond(message.id, { configOptions: [] })
  } else if (message.method === 'session/prompt') {
    promptId = message.id
    if (!modelSelected || message.params.prompt[0].text !== 'Implement the issue') process.exit(11)
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
      text('Waiting\n')
      return
    }
    send({ id: 'permission', method: 'session/request_permission', params: {
      sessionId, toolCall: { toolCallId: 'edit', title: 'Edit source' },
      options: scenario === 'deny-only'
        ? [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
        : [{ optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'once', name: 'Once', kind: 'allow_once' }]
    } })
  } else if (message.method === 'session/cancel' && scenario === 'cancel') {
    respond(promptId, { stopReason: 'cancelled' })
  }
})
