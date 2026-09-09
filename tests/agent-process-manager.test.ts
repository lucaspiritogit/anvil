import { onTestCleanup } from './test-cleanup'
import { expect, test } from 'vitest'
import { once } from 'node:events'
import { AgentProcessManager, type ExitInfo } from '../src/main/agents/process-manager'
import type { AgentDefinition, TaskEvent } from '../src/shared/types'

test('captures process output, cancels tasks and awaits shutdown', async () => {
  const agentProcesses = new AgentProcessManager()
  onTestCleanup(async () => {
    await agentProcesses.close()
    agentProcesses.removeAllListeners()
  })
  const events: TaskEvent[] = []
  agentProcesses.on('event', (event: TaskEvent) => events.push(event))
  const agent: AgentDefinition = {
    id: 'test', label: 'Test agent', description: 'Local output fixture',
    command: process.execPath,
    args: ['-e', `
      process.stdout.write('first')
      setTimeout(() => {
        process.stdout.write(' line\\n\\x1b[32msecond line\\x1b[0m\\ntrailing output')
        process.stderr.write('error line\\ntrailing error')
      }, 10)
    `]
  }
  try {
    const exited = once(agentProcesses, 'exit')
    agentProcesses.start({ taskId: 'output', agent, prompt: 'Capture output', cwd: process.cwd() })
    expect(agentProcesses.isRunning('output')).toBe(true)
    const [exit] = await exited as [ExitInfo]
    expect(exit).toStrictEqual({ taskId: 'output', code: 0, cancelled: false })
    expect(agentProcesses.isRunning('output')).toBe(false)
    expect(events.every((event) => event.taskId === 'output' && !('runId' in event))).toBeTruthy()
    expect(events.filter((event) => event.stream === 'stdout').map((event) => event.text)).toStrictEqual([
      'first line', 'second line', 'trailing output'
    ])
    expect(events.filter((event) => event.stream === 'stderr').map((event) => event.text)).toStrictEqual([
      'error line', 'trailing error'
    ])
    expect(events.filter((event) => event.stream === 'stdout').every((event) => event.category === 'message')).toBeTruthy()
    expect(events.filter((event) => event.stream === 'stderr').every((event) => event.category === 'error')).toBeTruthy()

    const cancelled = once(agentProcesses, 'exit')
    agentProcesses.start({
      taskId: 'cancelled', agent: { ...agent, args: ['-e', 'setInterval(() => {}, 1000)'] },
      prompt: 'Wait for cancellation', cwd: process.cwd()
    })
    expect(agentProcesses.cancel('cancelled')).toBe(true)
    const [cancelledExit] = await cancelled as [ExitInfo]
    expect(cancelledExit.taskId).toBe('cancelled')
    expect(cancelledExit.cancelled).toBe(true)
    expect(agentProcesses.isRunning('cancelled')).toBe(false)
    expect(events.some((event) => event.taskId === 'cancelled' && event.text === 'Task cancelled.')).toBeTruthy()

    for (const mode of ['unexpected', 'stop', 'shutdown'] as const) {
      const server = new AgentProcessManager({
        execute: async (input) => {
          if (mode !== 'unexpected') await new Promise<void>((resolve) => input.signal!.addEventListener('abort', () => resolve(), { once: true }))
          return { taskId: input.taskId, status: 'cancelled', output: '', changedFiles: [] }
        }
      })
      onTestCleanup(async () => {
        await server.close()
        server.removeAllListeners()
      })
      const exited = once(server, 'exit')
      server.start({ taskId: mode, agent: { ...agent, executionProtocol: 'acp' }, prompt: 'Wait', cwd: process.cwd() })
      if (mode === 'stop') server.cancel(mode)
      if (mode === 'shutdown') await server.close()
      const [result] = await exited as [ExitInfo]
      expect(result.cancelled, 'Only an explicit Stop marks a server task cancelled').toBe(mode === 'stop')
      expect(result.code).not.toBe(0)
      await server.close()
    }

    const missing = once(agentProcesses, 'exit')
    agentProcesses.start({
      taskId: 'missing', agent: { ...agent, command: '/anvil-test-missing-agent' },
      prompt: 'Missing command', cwd: process.cwd()
    })
    const [missingExit] = await missing as [ExitInfo]
    expect(missingExit.taskId).toBe('missing')
    expect(missingExit.code).toBe(null)
    expect(missingExit.error!).toMatch(/not installed or not on PATH/)
    const readyToClose = new Promise<void>((resolve) => {
      agentProcesses.on('event', (event: TaskEvent) => { if (event.text === 'Ready to close') resolve() })
    })
    const shutdownExit = once(agentProcesses, 'exit')
    agentProcesses.start({
      taskId: 'shutdown', agent: { ...agent, args: ['-e', 'process.on("SIGTERM", () => {}); console.log("Ready to close"); setInterval(() => {}, 1000)'] },
      prompt: 'Wait for shutdown', cwd: process.cwd()
    })
    await readyToClose
    await agentProcesses.close()
    expect(((await shutdownExit) as [ExitInfo])[0].cancelled, 'App shutdown is an interruption, not a user cancellation').toBe(false)
    expect(agentProcesses.isRunning('shutdown')).toBe(false)
    expect(() => agentProcesses.start({ taskId: 'late', agent, prompt: 'Too late', cwd: process.cwd() })).toThrow(/shutting down/)

  } finally {
    await agentProcesses.close()
  }
}, 30_000)

test('captures immutable issue ownership for sequential CLI and server turns', async () => {
  const executor: import('../src/main/agents/agent-executor').AgentExecutor = {
    async execute(input, emit) {
      await Promise.resolve()
      if (input.prompt === 'fail') throw new Error('transport failed')
      const output = new (await import('../src/main/agents/acp-output')).AcpOutput(input, emit)
      output.line('turn started', 'system', 'system')
      output.update({ sessionUpdate: 'tool_call', toolCallId: 'same-tool', title: 'Shell', status: 'pending' })
      output.update({ sessionUpdate: 'tool_call_update', toolCallId: 'same-tool', status: 'completed', rawOutput: 'done' })
      return { taskId: input.taskId, status: 'succeeded', output: '', changedFiles: [] }
    }
  }
  const manager = new AgentProcessManager(executor, executor)
  onTestCleanup(() => manager.close())
  const events: TaskEvent[] = []
  manager.on('event', event => events.push(event))
  for (const executionProtocol of [undefined, 'acp', 'codex-app-server'] as const) {
    const agent: AgentDefinition = {
      id: 'test', label: 'Test', description: '', command: process.execPath,
      args: ['-e', 'process.stdout.write("message\\ntrailing"); process.stderr.write("error")'],
      executionProtocol
    }
    for (const issueId of ['first', 'second', undefined]) {
      const offset = events.length
      const options = { taskId: 'shared-task', issueId, agent, prompt: 'run', cwd: process.cwd() }
      const exited = once(manager, 'exit')
      manager.start(options)
      options.issueId = 'changed-after-start'
      await exited
      const turn = events.slice(offset)
      expect(turn.length).toBeGreaterThan(0)
      expect(turn.every(event => event.issueId === issueId)).toBe(true)
      if (executionProtocol) {
        const snapshots = turn.filter(event => event.category === 'tool_result')
        expect(snapshots.map(event => event.text)).toEqual(['', 'done'])
        expect(snapshots[0].id).toBe(snapshots[1].id)
        expect(events.slice(0, offset).some(event => event.id === snapshots[0].id)).toBe(false)
      }
    }
    const offset = events.length
    const exited = once(manager, 'exit')
    manager.start({ taskId: 'shared-task', issueId: 'failed-issue', agent: { ...agent, command: '/missing-anvil-agent' }, prompt: 'fail', cwd: process.cwd() })
    await exited
    expect(events.slice(offset).some(event => event.category === 'error')).toBe(true)
    expect(events.slice(offset).every(event => event.issueId === 'failed-issue')).toBe(true)
  }
})

test('passes images intact to both server adapters and rejects text-only executors', async () => {
  const images = [{ filename: 'image.png', mimeType: 'image/png' as const, bytes: new Uint8Array([0, 128, 255]) }]
  const received: import('../src/main/agents/agent-executor').TaskInput[] = []
  const executor: import('../src/main/agents/agent-executor').AgentExecutor = {
    execute: async (input) => {
      received.push(input)
      input.onStarted?.()
      return { taskId: input.taskId, status: 'succeeded', output: 'Done', changedFiles: [] }
    }
  }
  const manager = new AgentProcessManager(executor, executor)
  onTestCleanup(() => manager.close())
  const events: TaskEvent[] = []
  manager.on('event', (event) => events.push(event))
  const agent: AgentDefinition = { id: 'fixture', label: 'Fixture', description: '', command: process.execPath, args: [] }
  for (const executionProtocol of ['acp', 'codex-app-server'] as const) {
    const exit = once(manager, 'exit')
    manager.start({ taskId: executionProtocol, agent: { ...agent, executionProtocol }, prompt: 'Image task', images, cwd: process.cwd() })
    await exit
    expect(received.at(-1)?.images).toEqual(images)
    expect(received.at(-1)?.prompt).toBe('Image task')
    expect(manager.isRunning(executionProtocol)).toBe(false)
  }
  expect(() => manager.start({ taskId: 'unsupported', agent, prompt: 'Image task', images, cwd: process.cwd() })).toThrow(/does not support image attachments/)
  expect(received).toHaveLength(2)
  expect(events).toHaveLength(0)
})
