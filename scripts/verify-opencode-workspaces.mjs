// Manual installed-CLI check. Uses only disposable profiles and fake API keys.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

const directory = await mkdtemp(join(tmpdir(), 'anvil-opencode-verification-'))
const children = new Set()
const blocker = createServer()
const version = execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim()
console.log(`Installed OpenCode ${version}; disposable profiles at ${directory}`)
assert.equal(version, '1.18.25')
const sentinelHome = join(directory, 'global')
await mkdir(join(sentinelHome, '.local/share/opencode'), { recursive: true })
await mkdir(join(sentinelHome, '.config/opencode'), { recursive: true })
const sentinels = [join(sentinelHome, '.local/share/opencode/auth.json'), join(sentinelHome, '.config/opencode/opencode.json')]
for (const path of sentinels) await writeFile(path, '{"sentinel":"unchanged"}\n')

async function profile(name) {
  const root = join(directory, name)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'TMPDIR', 'LANG', 'TERM', 'SYSTEMROOT'].includes(key)))
  Object.assign(environment, { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_PURE: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ['openai', 'anthropic', 'openrouter', 'opencode', 'opencode-go'] }) })
  for (const path of [environment.HOME, ...Object.entries(environment).filter(([key]) => key.startsWith('XDG_')).map(([, value]) => value)]) {
    await mkdir(path, { recursive: true })
  }
  return { name, root, environment, cwd: environment.HOME }
}

async function run(profile, args, loginKey) {
  console.log(`${profile.name}: opencode ${args.join(' ')}`)
  const child = spawn('opencode', args, { cwd: profile.cwd, env: profile.environment, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  let output = ''
  let errors = ''
  let entered = false
  child.stdout.on('data', (chunk) => {
    output += chunk
    if (loginKey && !entered && output.includes('Enter your API key')) {
      entered = true
      child.stdin.write(loginKey + '\r')
    }
  })
  child.stderr.on('data', (chunk) => { errors += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  try {
    const [code, signal] = await once(child, 'close')
    assert.equal(code, 0, `${args.join(' ')} failed: ${signal ?? errors}`)
    console.log(`${profile.name}: exit 0`)
    return output
  } finally {
    clearTimeout(timer)
    children.delete(child)
  }
}

async function startAcp(profile) {
  const args = ['acp', '--port', '0', '--hostname', '127.0.0.1', '--mdns=false']
  console.log(`${profile.name}: opencode ${args.join(' ')}`)
  const child = spawn('opencode', args, { cwd: profile.cwd, env: profile.environment, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  const closed = once(child, 'close')
  let errors = ''
  child.stderr.on('data', (chunk) => { errors += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  const ready = new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const response = JSON.parse(line)
      if (response.id !== 1) return
      if (response.error) reject(new Error(JSON.stringify(response.error)))
      else resolve(response.result)
    })
    child.once('error', reject)
    child.once('close', () => reject(new Error(`ACP exited before initialize: ${errors}`)))
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'anvil-isolation-probe', version: '1' } } }) + '\n')
  try {
    const initialized = await ready
    assert.equal(initialized.protocolVersion, 1)
    const sockets = execFileSync('lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' })
    const addresses = sockets.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1))
    assert.equal(addresses.length, 1, sockets)
    assert.match(addresses[0], /^127\.0\.0\.1:\d+$/)
    const port = Number(addresses[0].split(':')[1])
    assert.notEqual(port, 4096)
    console.log(`${profile.name}: ACP stdio initialized; native listener ${addresses[0]}`)
    return { port, async close() { child.kill('SIGTERM'); await closed; children.delete(child) } }
  } finally {
    clearTimeout(timer)
  }
}

try {
  const work = await profile('work')
  const personal = await profile('personal')
  for (const current of [work, personal]) {
    const paths = await run(current, ['debug', 'paths'])
    for (const kind of ['data', 'config', 'cache', 'state']) assert.ok(paths.includes(join(current.root, kind, 'opencode')), paths)
    await run(current, ['auth', 'login', '--provider', 'openai', '--method', 'Manually enter API Key'], `anvil-fake-${current.name}-key`)
    const auth = JSON.parse(await readFile(join(current.root, 'data/opencode/auth.json'), 'utf8'))
    assert.equal(auth.openai.key, `anvil-fake-${current.name}-key`)
    const status = await run(current, ['auth', 'list'])
    assert.ok(status.includes(join(current.root, 'data/opencode/auth.json')))
  }
  await run(work, ['auth', 'logout', 'openai'])
  assert.equal(JSON.parse(await readFile(join(work.root, 'data/opencode/auth.json'), 'utf8')).openai, undefined)
  assert.equal(JSON.parse(await readFile(join(personal.root, 'data/opencode/auth.json'), 'utf8')).openai.key, 'anvil-fake-personal-key')
  console.log('PASS: XDG paths, profile-local login/status/logout, independent credentials')
  await new Promise((resolve, reject) => {
    blocker.once('error', (error) => error.code === 'EADDRINUSE' ? resolve() : reject(error))
    blocker.listen(4096, '127.0.0.1', resolve)
  })
  const [workAcp, personalAcp] = await Promise.all([startAcp(work), startAcp(personal)])
  assert.notEqual(workAcp.port, personalAcp.port)
  await Promise.all([workAcp.close(), personalAcp.close()])
  for (const port of [workAcp.port, personalAcp.port]) {
    const probe = createServer()
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
    await new Promise((resolve) => probe.close(resolve))
  }
  for (const path of sentinels) assert.equal(await readFile(path, 'utf8'), '{"sentinel":"unchanged"}\n')
  console.log('PASS: concurrent native ACP ports, occupied-port fallback, released sockets, unchanged global sentinels')
} finally {
  await Promise.all([...children].map(async (child) => {
    const closed = once(child, 'close')
    child.kill('SIGKILL')
    await closed
  }))
  if (blocker.listening) await new Promise((resolve) => blocker.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
