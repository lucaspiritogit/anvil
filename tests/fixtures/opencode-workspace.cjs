const { createServer } = require('node:net')
const { createInterface } = require('node:readline')
const { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('1.18.25')
  process.exit(0)
}
const authPath = join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json')
const statePath = join(process.env.XDG_STATE_HOME, 'opencode', 'sessions.json')
const transcript = join(process.env.HOME, 'opencode.jsonl')
for (const root of [process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME, process.env.XDG_STATE_HOME]) {
  mkdirSync(join(root, 'opencode'), { recursive: true })
}
const record = (entry) => appendFileSync(transcript, JSON.stringify({ pid: process.pid, ...entry }) + '\n')
record({ event: 'spawn', args, cwd: process.cwd(), environment: process.env })
const readAuth = () => existsSync(authPath) ? JSON.parse(readFileSync(authPath, 'utf8')) : {}
if (args[0] === 'auth') {
  const auth = readAuth()
  if (args[1] === 'login') auth.openai = { type: 'api', key: args[2] }
  if (args[1] === 'logout') delete auth.openai
  if (args[1] !== 'list') writeFileSync(authPath, JSON.stringify(auth))
  console.log(Object.keys(auth).join('\n'))
  process.exit(0)
}
const key = readAuth().openai?.key ?? 'disconnected'
if (args[0] === 'models') {
  console.log(`openai/${key}`)
  console.log(JSON.stringify({ capabilities: { input: { image: true } }, variants: { high: {} } }, null, 2))
  console.log('amazon-bedrock/global-chain')
  console.log('{\n}')
  process.exit(0)
}
const option = (name) => args[args.indexOf(name) + 1]
const hostname = option('--hostname')
const port = Number(option('--port'))
if (hostname !== '127.0.0.1' || port !== 0 || !args.includes('--mdns=false')) process.exit(10)
const server = createServer()
const listening = new Promise((resolve, reject) => {
  server.once('error', () => {
    server.once('error', reject)
    server.listen(0, hostname, resolve)
  })
  server.listen(4096, hostname, resolve)
})
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const respond = (id, result) => send({ id, result })
let sessions = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : []
createInterface({ input: process.stdin }).on('line', async (line) => {
  const { id, method, params } = JSON.parse(line)
  record({ method, params })
  if (method === 'initialize') {
    await listening
    record({ event: 'listening', port: server.address().port, hostname: server.address().address })
    if (args.includes('--hang-startup')) return
    return respond(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } })
  }
  if (method === 'session/new') {
    const sessionId = `${key}:${sessions.length + 1}`
    sessions.push(sessionId)
    writeFileSync(statePath, JSON.stringify(sessions))
    return respond(id, { sessionId })
  }
  if (method === 'session/load') {
    if (!sessions.includes(params.sessionId)) return send({ id, error: { code: -32602, message: 'Session not found in workspace' } })
    return respond(id, {})
  }
  if (method === 'session/set_config_option') return respond(id, { configOptions: [] })
  if (method === 'session/prompt') {
    if (params.prompt[0].text === 'crash') process.exit(3)
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: key } } } })
    return respond(id, { stopReason: 'end_turn' })
  }
})
