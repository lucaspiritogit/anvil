const { createInterface } = require('node:readline')
const { spawn } = require('node:child_process')
const { appendFileSync } = require('node:fs')
const scenario = process.argv[2]
if (scenario === 'environment') {
  appendFileSync(process.argv[3], JSON.stringify({
    phase: process.argv.includes('--version') ? 'version' : 'connection',
    home: process.env.HOME, userProfile: process.env.USERPROFILE,
    configDir: process.env.CLAUDE_CONFIG_DIR, globalGit: process.env.GIT_CONFIG_GLOBAL,
    apiKey: process.env.ANTHROPIC_API_KEY, oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN
  }) + '\n')
}
if (process.argv.includes('--version')) {
  process.stdout.write(scenario === 'old' ? '2.1.100 (Claude Code)\n' : '2.1.288 (Claude Code)\n')
  process.exit(0)
}
const write = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const respond = (requestId, body) => write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: body } })
let permissionRequest
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'control_response') {
    respond(permissionRequest, { permission: message.response.response })
    return
  }
  const request = message.request
  if (request.subtype === 'initialize') {
    if (scenario === 'invalid') return process.stdout.write('invalid JSON\n')
    respond(message.request_id, { models: [{ value: 'sonnet' }], account: { tokenSource: 'claude.ai', apiProvider: 'firstParty' } })
  } else if (request.subtype === 'get_usage') {
    if (scenario === 'timeout') return
    respond(message.request_id, { rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: '2026-10-05T00:00:00Z' } }, session: { model_usage: {} } })
  } else if (request.subtype === 'unsupported') {
    write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'unsupported' } })
  } else if (request.subtype === 'permission') {
    permissionRequest = message.request_id
    write({ type: 'control_request', request_id: 'tool-approval', request: { subtype: 'can_use_tool', tool_name: 'Bash' } })
  } else if (request.subtype === 'diagnostic') {
    const config = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1])
    const secret = config.mcpServers.anvil_issue_tracker.headers.Authorization
    process.stderr.write('Failed header: ' + secret.slice(0, 5))
    setTimeout(() => {
      process.stderr.write(secret.slice(5) + '\n')
      respond(message.request_id, {})
    }, 10)
  } else if (request.subtype === 'child') {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    child.once('spawn', () => setTimeout(() => respond(message.request_id, { pid: child.pid }), 100))
  } else respond(message.request_id, request)
})
