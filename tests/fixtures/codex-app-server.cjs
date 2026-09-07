const { createInterface } = require('node:readline')
const { appendFileSync, realpathSync } = require('node:fs')
const [scenario, transcript] = process.argv.slice(2)
const threadId = 'thread-test'
const turnId = 'turn-test'
let initialized = false
let resumed = false
let steeringAttempts = 0
const requests = new Map()
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const respond = (id, result) => send({ id, result })
const notify = (method, params = {}) => send({ method, params: { threadId, turnId, ...params } })
const item = (item, complete = true) => notify(complete ? 'item/completed' : 'item/started', { item })
const turn = (status = 'inProgress', error = null) => ({ id: turnId, status, items: [], error })
const usage = (total) => notify('thread/tokenUsage/updated', { tokenUsage: {
  total: { inputTokens: total, cachedInputTokens: total / 2, outputTokens: total / 2, totalTokens: total * 1.5 },
  last: { inputTokens: 2, cachedInputTokens: 1, outputTokens: 1, totalTokens: 3 }, modelContextWindow: 100000
} })
const delta = (text, extra = {}) => notify('item/agentMessage/delta', { itemId: 'message', delta: text, ...extra })
const resultText = 'Done ✓\nCompleted issue-test through vl. Tests passed.'

if (scenario === 'cancel-hang') process.on('SIGTERM', () => {})

function finish() {
  if (scenario === 'failure' || scenario === 'interrupted' || scenario === 'invalid-status') {
    const status = scenario === 'failure' ? 'failed' : scenario === 'interrupted' ? 'interrupted' : 'inProgress'
    notify('turn/completed', { turn: turn(status, status === 'failed' ? { message: 'Provider rejected the turn' } : null) })
    return
  }
  // Recoverable provider errors must not finish the task ahead of turn/completed.
  notify('error', { error: { message: 'Retrying provider connection' }, willRetry: true })
  notify('unknown/futureNotification', { futureField: true })
  delta('wrong thread', { threadId: 'other-thread' })
  delta('old turn', { turnId: 'old-turn' })
  item({ id: 'reasoning', type: 'reasoning', summary: [], content: [] }, false)
  notify('item/reasoning/summaryTextDelta', { itemId: 'reasoning', summaryIndex: 0, delta: 'Thinking\n' })
  item({ id: 'reasoning', type: 'reasoning', summary: ['Thinking\n'], content: [] })
  item({ id: 'command', type: 'commandExecution', command: 'npm test', status: 'inProgress' }, false)
  notify('item/commandExecution/outputDelta', { itemId: 'command', delta: 'Tests pa' })
  item({ id: 'command', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'Tests passed\n', exitCode: 0 })
  item({ id: 'edit', type: 'fileChange', status: 'inProgress', changes: [{ path: '/changed.ts', kind: { type: 'update', move_path: '/renamed.ts' }, diff: 'diff' }] }, false)
  item({ id: 'edit', type: 'fileChange', status: 'completed', changes: [{ path: '/changed.ts', kind: { type: 'update', move_path: '/renamed.ts' }, diff: 'diff' }] })
  item({ id: 'failed-edit', type: 'fileChange', status: 'failed', changes: [{ path: '/failed.ts', kind: { type: 'add' }, diff: 'diff' }] })
  notify('turn/plan/updated', { explanation: 'One issue', plan: [{ step: 'Implement issue', status: 'completed' }] })
  item({ id: 'message', type: 'agentMessage', text: '' }, false)
  if (scenario !== 'snapshot-only') {
    if (scenario === 'revision') delta('Draft that will be replaced\n')
    else for (const character of resultText) delta(character)
  }
  item({ id: 'message', type: 'agentMessage', text: resultText, phase: 'final_answer' })
  item({ id: 'message', type: 'agentMessage', text: resultText, phase: 'final_answer' })
  delta('late duplicate delta')
  usage(resumed ? 1020 : 20)
  usage(resumed ? 1040 : 40)
  usage(resumed ? 1040 : 40)
  notify('thread/tokenUsage/updated', { threadId: 'other-thread', tokenUsage: {} })
  process.stderr.write('diagnostic\ntrailing diagnostic')
  notify('turn/completed', { turn: turn('completed') })
  notify('turn/completed', { turn: turn('completed') })
  delta('after completion')
}

function permission(method, id, params = {}) {
  requests.set(id, method)
  send({ id, method, params: { threadId, turnId, itemId: 'tool', ...params } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync(transcript, JSON.stringify(message) + '\n')
  if ('jsonrpc' in message) process.exit(20)
  if (requests.has(message.id) && !message.method) {
    const method = requests.get(message.id)
    if (method.includes('Execution/requestApproval') || method.includes('fileChange/requestApproval')) {
      const expectedDecision = scenario === 'read-only' || ['stale-command', 'foreign-command'].includes(message.id) ? 'cancel' : 'accept'
      if (message.result.decision !== expectedDecision) process.exit(21)
    } else if (method === 'unknown/serverRequest') {
      if (message.error.code !== -32601) process.exit(22)
    }
    requests.delete(message.id)
    if (!requests.size) finish()
    return
  }
  if (message.method === 'initialize') {
    if (scenario === 'startup-hang') return
    return respond(message.id, { userAgent: 'codex-fixture/0.153.3' })
  }
  if (message.method === 'initialized') {
    initialized = true
    return
  }
  if (!initialized) process.exit(23)
  if (message.method === 'model/list') {
    if (scenario === 'models-error') return send({ id: message.id, error: { code: -32000, message: 'Discovery unavailable' } })
    if (scenario === 'models-malformed') return respond(message.id, { data: [{ model: 'broken' }], nextCursor: null })
    if (scenario === 'models-empty') return respond(message.id, { data: [], nextCursor: null })
    if (scenario === 'models-hang') return
    const data = message.params.cursor ? [{
      id: 'plain-id', model: 'plain', supportedReasoningEfforts: [], defaultReasoningEffort: 'none'
    }] : [{
      id: 'catalogue-id', model: 'reasoner',
      supportedReasoningEfforts: [{ reasoningEffort: 'native-max', description: 'Maximum reasoning' }, { reasoningEffort: 'low', description: 'Fast reasoning' }],
      defaultReasoningEffort: 'native-max'
    }]
    return respond(message.id, { data, nextCursor: message.params.cursor && scenario !== 'models-cycle' ? null : 'page-2' })
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (scenario === 'rejected-effort') return send({ id: message.id, error: { code: -32602, message: 'Effort rejected by backend' } })
    if (realpathSync(message.params.cwd) !== process.cwd() || realpathSync(process.env.PWD) !== process.cwd()) process.exit(24)
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(message.params.sandbox)) {
      return send({ id: message.id, error: {
        code: -32600,
        message: "Invalid request: unknown variant `" + message.params.sandbox + "`, expected one of `read-only`, `workspace-write`, `danger-full-access`"
      } })
    }
    if (!['test-model', 'reasoner'].includes(message.params.model) || message.params.approvalPolicy !== 'never' || message.params.sandbox !== (scenario === 'read-only' ? 'read-only' : 'danger-full-access')) process.exit(25)
    if (scenario === 'bad-thread') return respond(message.id, { thread: { id: null } })
    resumed = message.method === 'thread/resume'
    if (resumed) {
      if (message.params.threadId !== threadId) process.exit(26)
      item({ id: 'old', type: 'agentMessage', text: 'old issue evidence' })
      if (scenario !== 'no-baseline') usage(1000)
    }
    // A shared session-tree ID must not replace the thread resume handle.
    return respond(message.id, { thread: { id: threadId, sessionId: 'session-tree', turns: [{ id: 'old-turn', items: [{ type: 'agentMessage', id: 'old', text: 'old history' }] }] } })
  }
  if (message.method === 'turn/start') {
    if (message.params.threadId !== threadId || message.params.input[0].text !== 'Implement the issue') process.exit(27)
    if (JSON.stringify(message.params.sandboxPolicy) !== JSON.stringify({ type: scenario === 'read-only' ? 'readOnly' : 'dangerFullAccess' })) process.exit(29)
    if (scenario === 'rpc-error') return send({ id: message.id, error: { code: -32603, message: 'Authenticate with codex login' } })
    if (scenario === 'exit') return process.exit(3)
    if (scenario === 'orphan') {
      require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
      return process.exit(3)
    }
    if (scenario === 'malformed') return process.stdout.write('invalid json\n')
    if (scenario === 'eof') return process.stdout.end()
    if (scenario === 'early-events') {
      finish()
      return respond(message.id, { turn: turn() })
    }
    if (scenario === 'cancel-before-ack') {
      notify('warning', { message: 'Abort before acknowledgement' })
      return setTimeout(() => respond(message.id, { turn: turn() }), 50)
    }
    respond(message.id, { turn: turn() })
    notify('turn/started', { turn: turn() })
    if (scenario.startsWith('cancel')) return delta('Waiting\n')
    if (scenario.startsWith('steer')) return delta('Waiting for steering\n')
    if (scenario === 'permissions' || scenario === 'read-only') {
      permission('item/commandExecution/requestApproval', 1, { availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] })
      permission('item/fileChange/requestApproval', 'file')
      permission('item/permissions/requestApproval', 'permissions', { permissions: { network: { enabled: true } } })
      permission('item/commandExecution/requestApproval', 'stale-command', { turnId: 'old-turn' })
      permission('item/commandExecution/requestApproval', 'foreign-command', { threadId: 'other-thread' })
      permission('item/permissions/requestApproval', 'stale-permissions', { turnId: 'old-turn', permissions: { network: { enabled: true } } })
      permission('item/permissions/requestApproval', 'foreign-permissions', { threadId: 'other-thread', permissions: { network: { enabled: true } } })
      permission('mcpServer/elicitation/request', 'elicitation')
      permission('item/tool/requestUserInput', 'input')
      permission('unknown/serverRequest', 'unknown')
      return
    }
    // The acknowledgement cannot be interpreted as successful completion.
    setTimeout(finish, 30)
  } else if (message.method === 'turn/steer') {
    if (message.params.threadId !== threadId || message.params.expectedTurnId !== turnId) process.exit(30)
    if (message.params.input[0].text !== 'Adjust validation') process.exit(31)
    if (scenario === 'steer-error' && steeringAttempts++ === 0) {
      return send({ id: message.id, error: { code: -32600, message: 'Steering not permitted for this turn' } })
    }
    respond(message.id, { turnId })
    setTimeout(finish, 30)
  } else if (message.method === 'turn/interrupt') {
    if (message.params.threadId !== threadId || message.params.turnId !== turnId) process.exit(28)
    if (scenario === 'cancel-hang') return
    respond(message.id, {})
    notify('turn/completed', { turn: turn('interrupted') })
  }
})
