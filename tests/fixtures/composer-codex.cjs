// Test-only Codex transport. Records requests without executing tools or changing files.
// ANVIL_SMOKE_LIVE_CODEX optionally observes a real server and stops at turn acceptance.
const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const transcript = process.env.ANVIL_SMOKE_TRANSCRIPT
const record = (entry) => appendFileSync(transcript, JSON.stringify(entry) + '\n')
const send = (entry) => process.stdout.write(JSON.stringify(entry) + '\n')
const input = createInterface({ input: process.stdin })
if (process.env.ANVIL_SMOKE_LIVE_CODEX) {
  const child = spawn(process.env.ANVIL_SMOKE_LIVE_CODEX, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] })
  let turnRequest
  input.on('line', (line) => {
    const message = JSON.parse(line)
    record({ ...message, processCwd: process.cwd() })
    if (message.method === 'turn/start') turnRequest = message.id
    child.stdin.write(line + '\n')
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (turnRequest !== undefined && message.id === turnRequest) {
      record({ accepted: !message.error, error: message.error })
      send(message)
      child.kill('SIGTERM')
    } else if (message.id !== undefined && message.method) {
      // A smoke check must never approve model tool requests.
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Smoke check does not execute tools' } }) + '\n')
    } else send(message)
  })
  child.on('exit', () => process.exit())
  process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit() })
  input.on('close', () => child.kill('SIGTERM'))
} else {
  input.on('line', (line) => {
    const message = JSON.parse(line)
    record({ ...message, processCwd: process.cwd() })
    const respond = (result) => send({ id: message.id, result })
    if (message.method === 'initialize') respond({ userAgent: 'anvil-composer-smoke' })
    if (message.method === 'config/read') respond({ config: { cli_auth_credentials_store: 'file' } })
    if (message.method === 'account/read') respond({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })
    if (message.method === 'model/list') respond({ data: [{
      id: 'smoke-vision', model: 'smoke-vision', isDefault: true, inputModalities: ['text', 'image'],
      supportedReasoningEfforts: [], defaultReasoningEffort: 'none'
    }], nextCursor: null })
    if (message.method === 'thread/start') respond({ thread: { id: 'smoke-thread' } })
    if (message.method === 'turn/start') {
      respond({ turn: { id: 'smoke-turn', status: 'inProgress', items: [] } })
      record({ accepted: true })
    }
    if (message.method === 'turn/interrupt') {
      respond({})
      send({ method: 'turn/completed', params: { threadId: 'smoke-thread', turn: { id: 'smoke-turn', status: 'interrupted', items: [] } } })
    }
  })
}
