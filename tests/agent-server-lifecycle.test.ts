import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import { OpenCodeAcpClient } from '../src/main/agents/opencode-acp'
import { CodexAppServerClient } from '../src/main/agents/codex-app-server'
import { AgentProcessManager, type ExitInfo } from '../src/main/agents/process-manager'
import { getAgent } from '../src/main/agents/registry'
import type { TaskEvent, TaskInput } from '../src/main/agents/agent-executor'

type Executor = OpenCodeAcpClient | CodexAppServerClient
interface TranscriptEntry {
  pid: number
  event?: string
  childPid?: number
  method?: string
  params?: { cwd?: string }
}

async function assertExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await delay(20)
  }
  assert.fail(`Process ${pid} survived shutdown`)
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-server-lifecycle-'))
  const otherDirectory = join(directory, 'other-project')
  await mkdir(otherDirectory)
  const fixture = resolve('tests/fixtures/agent-server-lifecycle.cjs')
  const clients: Executor[] = []
  const timeout = setTimeout(() => { console.error('Server lifecycle tests timed out'); process.exit(1) }, 30_000)
  try {
    for (const protocol of ['acp', 'codex'] as const) {
      let nextClient = 0
      const create = () => {
        const transcript = join(directory, `${protocol}-${++nextClient}.jsonl`)
        const options = { command: process.execPath, args: [fixture, protocol, transcript], cancelTimeoutMs: 50 }
        const client = protocol === 'acp' ? new OpenCodeAcpClient(options) : new CodexAppServerClient(options)
        clients.push(client)
        const entries = async (): Promise<TranscriptEntry[]> => (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
        return { client, transcript, entries }
      }
      const input = (prompt: string, extra: Partial<TaskInput> = {}): TaskInput => ({ taskId: prompt, cwd: directory, prompt, ...extra })
      const freshMethod = protocol === 'acp' ? 'session/new' : 'thread/start'
      const resumeMethod = protocol === 'acp' ? 'session/load' : 'thread/resume'
      const shared = create()
      assert.equal(existsSync(shared.transcript), false, 'Construction must not launch a process')
      const events: TaskEvent[] = []
      const record = (event: TaskEvent): void => { events.push(event) }
      const [first, second] = await Promise.all([
        shared.client.execute(input('first'), record),
        shared.client.execute(input('second', { cwd: otherDirectory }), record)
      ])
      assert.equal(first.status, 'succeeded', first.error)
      assert.equal(second.status, 'succeeded', second.error)
      assert.equal(first.output, 'first')
      assert.equal(second.output, 'second')
      assert.notEqual(first.sessionId, second.sessionId)
      assert.ok(events.filter((event) => event.type === 'output' && event.event.category === 'message')
        .every((event) => event.type === 'output' && event.event.text === event.event.taskId), 'Route concurrent output by session/thread')
      const initial = await shared.entries()
      assert.equal(initial.filter((entry) => entry.event === 'spawn').length, 1)
      assert.equal(initial.filter((entry) => entry.method === 'initialize').length, 1)
      assert.deepEqual(initial.filter((entry) => entry.method === freshMethod).map((entry) => entry.params?.cwd), [directory, otherDirectory])
      const pid = initial[0].pid
      process.kill(pid, 0)
      const third = await shared.client.execute(input('third'), record)
      assert.equal(third.output, 'third')
      assert.notEqual(third.sessionId, first.sessionId)
      const resumed = await shared.client.execute(input('resumed', { resumeSessionId: first.sessionId }), record)
      assert.equal(resumed.output, 'resumed', 'Do not replay old output on resume')
      assert.equal(resumed.sessionId, first.sessionId)
      const sequential = await shared.entries()
      assert.equal(sequential.filter((entry) => entry.event === 'spawn').length, 1)
      assert.equal(sequential.filter((entry) => entry.method === freshMethod).length, 3)
      assert.equal(sequential.filter((entry) => entry.method === resumeMethod).length, 1)
      assert.equal(events.filter((event) => event.type === 'output' && event.event.text.startsWith('$ ')).length, 1, 'Only log an actual launch')

      const controller = new AbortController()
      const [cancelled, peer] = await Promise.all([
        shared.client.execute(input('cancel-me', { signal: controller.signal }), (event) => {
          if (event.type === 'output' && event.event.text === 'Waiting') controller.abort()
        }),
        shared.client.execute(input('peer'), record)
      ])
      assert.equal(cancelled.status, 'cancelled')
      assert.equal(peer.output, 'peer', 'Cancellation must not interrupt another session')
      assert.equal((await shared.client.execute(input('after-cancel'), record)).status, 'succeeded')
      assert.equal((await shared.entries()).filter((entry) => entry.event === 'spawn').length, 1)
      const closing = shared.client.close()
      assert.equal(shared.client.close(), closing, 'Shutdown is idempotent')
      await closing
      await assertExited(pid)
      assert.equal((await shared.client.execute(input('after-close'), record)).status, 'failed')
      assert.equal((await shared.entries()).filter((entry) => entry.event === 'spawn').length, 1)

      const starting = create()
      const startupAbort = new AbortController()
      const abandoned = starting.client.execute(input('abandoned', { signal: startupAbort.signal }), record)
      const survivor = starting.client.execute(input('survivor'), record)
      startupAbort.abort()
      assert.equal((await abandoned).status, 'cancelled')
      assert.equal((await survivor).output, 'survivor', 'Cancelling shared startup must not poison another turn')
      assert.equal((await starting.entries()).filter((entry) => entry.event === 'spawn').length, 1)
      await starting.client.close()

      const recovering = create()
      assert.equal((await recovering.client.execute(input('crash'), record)).status, 'failed')
      assert.equal((await recovering.client.execute(input('after-crash'), record)).output, 'after-crash')
      assert.equal((await recovering.entries()).filter((entry) => entry.event === 'spawn').length, 2)
      const hungAbort = new AbortController()
      const hung = await recovering.client.execute(input('hang', { signal: hungAbort.signal }), (event) => {
        if (event.type === 'output' && event.event.text === 'Waiting') hungAbort.abort()
      })
      assert.equal(hung.status, 'cancelled')
      assert.equal((await recovering.client.execute(input('after-hang'), record)).output, 'after-hang')
      assert.equal((await recovering.entries()).filter((entry) => entry.event === 'spawn').length, 3)
      await recovering.client.close()
      for (const entry of await recovering.entries()) if (entry.event === 'spawn') await assertExited(entry.pid)

      const busy = create()
      const manager = protocol === 'acp' ? new AgentProcessManager(busy.client) : new AgentProcessManager(undefined, busy.client)
      const exited = once(manager, 'exit')
      const waiting = new Promise<void>((resolve) => manager.on('event', (event) => { if (event.text === 'Waiting') resolve() }))
      manager.start({ ...input('hang'), agent: getAgent(protocol === 'acp' ? 'opencode' : 'codex')! })
      await waiting
      const shutdown = manager.close()
      assert.equal(manager.close(), shutdown)
      assert.throws(() => manager.start({ ...input('rejected'), agent: getAgent('codex')! }), /shutting down/)
      await shutdown
      assert.equal(((await exited) as [ExitInfo])[0].cancelled, true)
      assert.equal(manager.isRunning('hang'), false)
      await assertExited((await busy.entries())[0].pid)

      const startupShutdown = create()
      const startupTask = startupShutdown.client.execute(input('never-started'), record)
      await startupShutdown.client.close()
      assert.equal((await startupTask).status, 'failed', 'Shutdown must unblock an in-flight handshake')

      const unused = create()
      await unused.client.close()
      assert.equal(existsSync(unused.transcript), false, 'Closing an unused executor must not launch it')

      if (process.platform !== 'win32') {
        const stubborn = create()
        assert.equal((await stubborn.client.execute(input('child'), record)).status, 'succeeded')
        const entries = await stubborn.entries()
        const childPid = entries.find((entry) => entry.event === 'child')!.childPid!
        process.kill(childPid, 0)
        await stubborn.client.close()
        await assertExited(entries[0].pid)
        await assertExited(childPid)
      }
    }
    console.log('Agent server lifecycle tests passed: lazy startup, concurrent routing, fresh/resumed sessions, reuse, cancellation isolation, crash recovery, shutdown, and descendant cleanup.')
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    clearTimeout(timeout)
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
