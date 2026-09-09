// Native fake provider owns its profile file. Never writes a request transcript.
const { createInterface } = require('node:readline')
const { existsSync, readFileSync, writeFileSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')
const path = join(process.env.CODEX_HOME, 'auth.json')
const write = (message) => process.stdout.write(JSON.stringify(message) + '\n')
let timer
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  const result = (value) => write({ id, result: value })
  if (method === 'initialize') return result({ userAgent: 'workspace-auth-fixture' })
  if (method === 'config/read') return result({ config: { cli_auth_credentials_store: 'file' } })
  if (method === 'account/read') return result({ requiresOpenaiAuth: true, account: existsSync(path) ? JSON.parse(readFileSync(path)).summary : null })
  if (method === 'account/login/start') {
    if (params.type === 'apiKey') {
      writeFileSync(path, JSON.stringify({ summary: { type: 'apiKey' }, fixtureSecret: params.apiKey }), { mode: 0o600 })
      return result({ type: 'apiKey' })
    }
    result({ type: 'chatgpt', loginId: 'fixture-login', authUrl: 'https://auth.openai.com/authorize?state=fixture' })
    timer = setTimeout(() => {
      writeFileSync(path, JSON.stringify({ summary: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } }), { mode: 0o600 })
      write({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true, error: null } })
    }, 100)
    return
  }
  if (method === 'account/login/cancel') {
    clearTimeout(timer)
    result({ status: 'canceled' })
    return write({ method: 'account/login/completed', params: { loginId: params.loginId, success: false, error: null } })
  }
  if (method === 'account/logout') {
    if (existsSync(path)) unlinkSync(path)
    return result({})
  }
  write({ id, error: { code: -32601, message: 'Unsupported fixture method' } })
})
