const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const { spawn } = require('node:child_process')

const [protocol, transcript] = process.argv.slice(2)
const isAcp = protocol === 'acp'
const record = (entry) => appendFileSync(transcript, JSON.stringify({ pid: process.pid, ...entry }) + '\n')
record({ event: 'spawn' })
const send = (message) => process.stdout.write(JSON.stringify(isAcp ? { jsonrpc: '2.0', ...message } : message) + '\n')
const respond = (id, result) => send({ id, result })
const sessions = new Map()
const permissions = new Map()
let nextSession = 0
let nextTurn = 0

function text(session, value) {
  send(isAcp
    ? { method: 'session/update', params: { sessionId: session.id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } } }
    : { method: 'item/agentMessage/delta', params: { threadId: session.id, turnId: session.turnId, itemId: 'message', delta: value } })
}
function finish(session, cancelled = false) {
  clearTimeout(session.timer)
  if (isAcp) respond(session.requestId, { stopReason: cancelled ? 'cancelled' : 'end_turn' })
  else send({ method: 'turn/completed', params: { threadId: session.id, turn: { id: session.turnId, status: cancelled ? 'interrupted' : 'completed', items: [], error: null } } })
}
function complete(session) {
  text(session, session.prompt)
  finish(session)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  record(message)
  const { method, params = {}, id } = message
  if (permissions.has(id) && !method) {
    const session = permissions.get(id)
    permissions.delete(id)
    if (isAcp ? message.result.outcome.optionId !== 'once' : message.result.decision !== 'decline') process.exit(10)
    session.timer = setTimeout(() => complete(session), 60)
    return
  }
  if (method === 'initialize') {
    // Allow overlapping executions and cancellation during the shared handshake.
    return setTimeout(() => respond(id, isAcp
      ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      : { userAgent: 'lifecycle-fixture' }), 40)
  }
  if (method === 'initialized') return
  if (method === 'session/new' || method === 'thread/start') {
    const sessionId = `session-${process.pid}-${++nextSession}`
    sessions.set(sessionId, { id: sessionId, cwd: params.cwd })
    return respond(id, isAcp ? { sessionId } : { thread: { id: sessionId } })
  }
  if (method === 'session/load' || method === 'thread/resume') {
    const sessionId = params.sessionId ?? params.threadId
    const session = sessions.get(sessionId)
    if (!session) process.exit(11)
    text(session, 'old history')
    return respond(id, isAcp ? {} : { thread: { id: sessionId } })
  }
  if (method === 'session/set_config_option') return respond(id, { configOptions: [] })
  if (method === 'session/prompt' || method === 'turn/start') {
    const session = sessions.get(params.sessionId ?? params.threadId)
    session.requestId = id
    session.turnId = `turn-${++nextTurn}`
    session.prompt = (params.prompt ?? params.input)[0].text
    if (session.prompt === 'crash') return process.exit(3)
    if (!isAcp) respond(id, { turn: { id: session.turnId, status: 'inProgress', items: [], error: null } })
    if (['cancel-me', 'hang'].includes(session.prompt)) {
      text(session, 'Waiting\n')
      return
    }
    if (session.prompt === 'child') {
      process.on('SIGTERM', () => {})
      // Also check descendants that keep no pipes open and ignore termination.
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.once('data', () => {
        record({ event: 'child', childPid: child.pid })
        complete(session)
      })
      return
    }
    const permissionId = `permission-${session.id}`
    permissions.set(permissionId, session)
    send(isAcp
      ? { id: permissionId, method: 'session/request_permission', params: { sessionId: session.id, toolCall: { toolCallId: 'tool', title: session.prompt }, options: [{ optionId: 'once', name: 'Once', kind: 'allow_once' }] } }
      : { id: permissionId, method: 'item/commandExecution/requestApproval', params: { threadId: session.id, turnId: session.turnId, itemId: 'tool' } })
    return
  }
  if (method === 'session/cancel' || method === 'turn/interrupt') {
    const session = sessions.get(params.sessionId ?? params.threadId)
    if (session.prompt === 'hang') return
    if (!isAcp) respond(id, {})
    finish(session, true)
  }
})
