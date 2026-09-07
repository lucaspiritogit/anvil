import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { initializeTracker } from 'valence'
import { codexSandboxPolicy } from '../src/main/agents/codex-sandbox'

async function main(): Promise<void> {
  const directory = await realpath(await mkdtemp(join(process.env.ANVIL_TEST_CODEX_SANDBOX === '1' ? homedir() : tmpdir(), '.anvil-codex-sandbox-')))
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  process.env.HOME = join(directory, 'home')
  process.env.USERPROFILE = join(directory, 'home')
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  try {
    const project = join(directory, 'project')
    const first = join(directory, 'first')
    const second = join(directory, 'second')
    await mkdir(project)
    git(project, 'init', '-b', 'main')
    git(project, 'config', 'user.name', 'Anvil test')
    git(project, 'config', 'user.email', 'anvil-test@example.invalid')
    git(project, 'commit', '--allow-empty', '-m', 'Initial commit')
    git(project, 'worktree', 'add', '-b', 'first', first)
    git(project, 'worktree', 'add', '-b', 'second', second)
    await mkdir(join(first, 'app'))
    const policy = await codexSandboxPolicy(join(first, 'app'))
    assert.deepEqual(policy.writableRoots, [join(first, 'app'), first, join(project, '.git/worktrees/first'), join(project, '.git')])
    assert.ok(!policy.writableRoots.includes(project))
    assert.ok(!policy.writableRoots.includes(second))
    const secondPolicy = await codexSandboxPolicy(second)
    assert.ok(!secondPolicy.writableRoots.includes(first), 'Each turn must recompute its own roots')
    assert.equal(policy.networkAccess, true)
    const tracker = initializeTracker(project)
    tracker.close()
    const trackerPolicy = await codexSandboxPolicy(first, project)
    assert.equal(tracker.databasePath, join(directory, 'home/.config/valence/project/sqlite.db'))
    assert.ok(trackerPolicy.writableRoots.includes(dirname(tracker.databasePath)))
    assert.ok(!trackerPolicy.writableRoots.includes(project), 'Grant SQLite storage, not source files')
    assert.ok(!trackerPolicy.writableRoots.includes(second))

    if (process.env.ANVIL_TEST_CODEX_SANDBOX === '1') {
      const home = join(directory, 'codex-home')
      await mkdir(home)
      const script = join(first, 'check.cjs')
      await writeFile(script, `
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const net = require('node:net')
const git = (...args) => execFileSync('git', args, { cwd: ${JSON.stringify(first)}, encoding: 'utf8' })
writeFileSync(${JSON.stringify(join(first, 'icon.svg'))}, '<svg/>')
git('add', 'icon.svg')
git('commit', '-m', 'fix: icon')
assert.throws(() => writeFileSync(${JSON.stringify(join(project, 'do-not-write'))}, 'bad'))
assert.throws(() => writeFileSync(${JSON.stringify(join(second, 'do-not-write'))}, 'bad'))
const server = net.createServer()
server.on('error', (error) => { throw error })
server.listen(0, '127.0.0.1', () => server.close(() => console.log('Sandbox commit, local server, and isolation passed')))
`)
      // Exercise the installed app-server's actual sandbox without calling a model.
      const server = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        cwd: first, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore']
      })
      try {
        const response = await new Promise<any>((resolveResponse, rejectResponse) => {
          const timeout = setTimeout(() => rejectResponse(new Error('Sandbox command timed out')), 30_000)
          server.on('error', rejectResponse)
          server.on('exit', () => { clearTimeout(timeout); rejectResponse(new Error('Sandbox server exited')) })
          const lines = createInterface({ input: server.stdout })
          lines.on('line', (line) => {
            const message = JSON.parse(line)
            if (message.id === 1) {
              server.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
              server.stdin.write(`${JSON.stringify({ id: 2, method: 'command/exec', params: {
                command: [process.env.ANVIL_TEST_NODE ?? process.execPath, script], cwd: first, sandboxPolicy: policy
              } })}\n`)
            }
            if (message.id === 2) {
              clearTimeout(timeout)
              lines.close()
              resolveResponse(message)
            }
          })
          server.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'anvil-test', version: '0.1.0' } } })}\n`)
        })
        assert.equal(response.error, undefined, JSON.stringify(response.error))
        assert.equal(response.result.exitCode, 0, response.result.stderr)
        console.log(response.result.stdout.trim())
      } finally {
        server.kill()
      }
      assert.equal(git(first, 'log', '-1', '--format=%s'), 'fix: icon')
      assert.equal(git(project, 'branch', '--show-current'), 'main')
    }
    console.log('Codex sandbox roots passed: linked Git metadata, nested projects, and separate task roots.')
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
