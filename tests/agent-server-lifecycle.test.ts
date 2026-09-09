import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'
import { expect, test } from 'vitest'
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
  expect.fail(`Process ${pid} survived shutdown`)
}

test('reuses and recovers protocol servers and awaits descendant shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-server-lifecycle-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const otherDirectory = join(directory, 'other-project')
  await mkdir(otherDirectory)
  const fixture = resolve('tests/fixtures/agent-server-lifecycle.cjs')
  const clients: Executor[] = []
  try {
    for (const protocol of ['acp', 'codex'] as const) {
      let nextClient = 0
      const create = () => {
        const transcript = join(directory, `${protocol}-${++nextClient}.jsonl`)
        const options = { command: process.execPath, args: [fixture, protocol, transcript], cancelTimeoutMs: 50 }
        const client = protocol === 'acp' ? new OpenCodeAcpClient(options) : new CodexAppServerClient({ ...options, workspace: testWorkspace() })
        onTestCleanup(() => client.close())
        clients.push(client)
        const entries = async (): Promise<TranscriptEntry[]> => (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
        return { client, transcript, entries }
      }
      const input = (prompt: string, extra: Partial<TaskInput> = {}): TaskInput => ({ workspace: testWorkspace(), taskId: prompt, cwd: directory, prompt, ...extra })
      const freshMethod = protocol === 'acp' ? 'session/new' : 'thread/start'
      const resumeMethod = protocol === 'acp' ? 'session/load' : 'thread/resume'
      const shared = create()
      expect(existsSync(shared.transcript), 'Construction must not launch a process').toBe(false)
      const events: TaskEvent[] = []
      const record = (event: TaskEvent): void => { events.push(event) }
      const [first, second] = await Promise.all([
        shared.client.execute(input('first'), record),
        shared.client.execute(input('second', { cwd: otherDirectory }), record)
      ])
      expect(first.status, first.error).toBe('succeeded')
      expect(second.status, second.error).toBe('succeeded')
      expect(first.output).toBe('first')
      expect(second.output).toBe('second')
      expect(first.sessionId).not.toBe(second.sessionId)
      expect(events.filter((event) => event.type === 'output' && event.event.category === 'message')
        .every((event) => event.type === 'output' && event.event.text === event.event.taskId), 'Route concurrent output by session/thread').toBeTruthy()
      const initial = await shared.entries()
      expect(initial.filter((entry) => entry.event === 'spawn').length).toBe(1)
      expect(initial.filter((entry) => entry.method === 'initialize').length).toBe(1)
      const freshCwds = initial.filter((entry) => entry.method === freshMethod).map((entry) => entry.params?.cwd)
      freshCwds.sort()
      expect(freshCwds, 'Concurrent tasks use their own cwd').toStrictEqual([directory, otherDirectory].sort())
      const pid = initial[0].pid
      process.kill(pid, 0)
      const third = await shared.client.execute(input('third'), record)
      expect(third.output).toBe('third')
      expect(third.sessionId).not.toBe(first.sessionId)
      const resumed = await shared.client.execute(input('resumed', { resumeSessionId: first.sessionId }), record)
      expect(resumed.output, 'Do not replay old output on resume').toBe('resumed')
      expect(resumed.sessionId).toBe(first.sessionId)
      const sequential = await shared.entries()
      expect(sequential.filter((entry) => entry.event === 'spawn').length).toBe(1)
      expect(sequential.filter((entry) => entry.method === freshMethod).length).toBe(3)
      expect(sequential.filter((entry) => entry.method === resumeMethod).length).toBe(1)
      expect(events.filter((event) => event.type === 'output' && event.event.text.startsWith('$ ')).length, 'Only log an actual launch').toBe(1)

      const controller = new AbortController()
      const [cancelled, peer] = await Promise.all([
        shared.client.execute(input('cancel-me', { signal: controller.signal }), (event) => {
          if (event.type === 'output' && event.event.text === 'Waiting\n') controller.abort()
        }),
        shared.client.execute(input('peer'), record)
      ])
      expect(cancelled.status).toBe('cancelled')
      expect(peer.output, 'Cancellation must not interrupt another session').toBe('peer')
      expect((await shared.client.execute(input('after-cancel'), record)).status).toBe('succeeded')
      expect((await shared.entries()).filter((entry) => entry.event === 'spawn').length).toBe(1)
      const closing = shared.client.close()
      expect(shared.client.close(), 'Shutdown is idempotent').toBe(closing)
      await closing
      await assertExited(pid)
      expect((await shared.client.execute(input('after-close'), record)).status).toBe('failed')
      expect((await shared.entries()).filter((entry) => entry.event === 'spawn').length).toBe(1)

      const starting = create()
      const startupAbort = new AbortController()
      const abandoned = starting.client.execute(input('abandoned', { signal: startupAbort.signal }), record)
      const survivor = starting.client.execute(input('survivor'), record)
      startupAbort.abort()
      expect((await abandoned).status).toBe('cancelled')
      expect((await survivor).output, 'Cancelling shared startup must not poison another turn').toBe('survivor')
      expect((await starting.entries()).filter((entry) => entry.event === 'spawn').length).toBe(1)
      await starting.client.close()

      const recovering = create()
      expect((await recovering.client.execute(input('crash'), record)).status).toBe('failed')
      expect((await recovering.client.execute(input('after-crash'), record)).output).toBe('after-crash')
      expect((await recovering.entries()).filter((entry) => entry.event === 'spawn').length).toBe(2)
      const hungAbort = new AbortController()
      const hung = await recovering.client.execute(input('hang', { signal: hungAbort.signal }), (event) => {
        if (event.type === 'output' && event.event.text === 'Waiting\n') hungAbort.abort()
      })
      expect(hung.status).toBe('cancelled')
      expect((await recovering.client.execute(input('after-hang'), record)).output).toBe('after-hang')
      expect((await recovering.entries()).filter((entry) => entry.event === 'spawn').length).toBe(3)
      await recovering.client.close()
      for (const entry of await recovering.entries()) if (entry.event === 'spawn') await assertExited(entry.pid)

      const busy = create()
      const manager = protocol === 'acp' ? new AgentProcessManager(busy.client) : new AgentProcessManager(undefined, busy.client)
      onTestCleanup(async () => {
        await manager.close()
        manager.removeAllListeners()
      })
      const exited = once(manager, 'exit')
      const waiting = new Promise<void>((resolve) => manager.on('event', (event) => { if (event.text === 'Waiting\n') resolve() }))
      manager.start({ ...input('hang'), agent: getAgent(protocol === 'acp' ? 'opencode' : 'codex')! })
      await waiting
      const shutdown = manager.close()
      expect(manager.close()).toBe(shutdown)
      expect(() => manager.start({ ...input('rejected'), agent: getAgent('codex')! })).toThrow(/shutting down/)
      await shutdown
      expect(((await exited) as [ExitInfo])[0].cancelled, 'App shutdown must leave the task resumable').toBe(false)
      expect(manager.isRunning('hang')).toBe(false)
      await assertExited((await busy.entries())[0].pid)

      const startupShutdown = create()
      const startupTask = startupShutdown.client.execute(input('never-started'), record)
      await startupShutdown.client.close()
      expect((await startupTask).status, 'Shutdown must unblock an in-flight handshake').toBe('failed')

      const unused = create()
      await unused.client.close()
      expect(existsSync(unused.transcript), 'Closing an unused executor must not launch it').toBe(false)

      if (process.platform !== 'win32') for (const prompt of ['child', 'detached-child']) {
        const stubborn = create()
        expect((await stubborn.client.execute(input(prompt), record)).status).toBe('succeeded')
        const entries = await stubborn.entries()
        const childPid = entries.find((entry) => entry.event === 'child')!.childPid!
        onTestCleanup(() => {
          try { process.kill(childPid, 'SIGKILL') } catch {}
        })
        process.kill(childPid, 0)
        await stubborn.client.close()
        await assertExited(entries[0].pid)
        await assertExited(childPid)
      }
    }

  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
