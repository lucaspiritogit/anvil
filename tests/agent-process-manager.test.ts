import assert from 'node:assert/strict'
import { once } from 'node:events'
import { AgentProcessManager, type ExitInfo } from '../src/main/agents/process-manager'
import type { AgentDefinition, TaskEvent } from '../src/shared/types'

async function main(): Promise<void> {
  const agentProcesses = new AgentProcessManager()
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
  const timeout = setTimeout(() => agentProcesses.cancelAll(), 10_000)
  try {
    const exited = once(agentProcesses, 'exit')
    agentProcesses.start({ taskId: 'output', agent, prompt: 'Capture output', cwd: process.cwd() })
    assert.equal(agentProcesses.isRunning('output'), true)
    const [exit] = await exited as [ExitInfo]
    assert.deepEqual(exit, { taskId: 'output', code: 0, cancelled: false })
    assert.equal(agentProcesses.isRunning('output'), false)
    assert.ok(events.every((event) => event.taskId === 'output' && !('runId' in event)))
    assert.deepEqual(events.filter((event) => event.stream === 'stdout').map((event) => event.text), [
      'first line', 'second line', 'trailing output'
    ])
    assert.deepEqual(events.filter((event) => event.stream === 'stderr').map((event) => event.text), [
      'error line', 'trailing error'
    ])
    assert.ok(events.filter((event) => event.stream === 'stdout').every((event) => event.category === 'message'))
    assert.ok(events.filter((event) => event.stream === 'stderr').every((event) => event.category === 'error'))

    const cancelled = once(agentProcesses, 'exit')
    agentProcesses.start({
      taskId: 'cancelled', agent: { ...agent, args: ['-e', 'setInterval(() => {}, 1000)'] },
      prompt: 'Wait for cancellation', cwd: process.cwd()
    })
    assert.equal(agentProcesses.cancel('cancelled'), true)
    const [cancelledExit] = await cancelled as [ExitInfo]
    assert.equal(cancelledExit.taskId, 'cancelled')
    assert.equal(cancelledExit.cancelled, true)
    assert.equal(agentProcesses.isRunning('cancelled'), false)
    assert.ok(events.some((event) => event.taskId === 'cancelled' && event.text === 'Task cancelled.'))

    for (const mode of ['unexpected', 'stop', 'shutdown'] as const) {
      const server = new AgentProcessManager({
        execute: async (input) => {
          if (mode !== 'unexpected') await new Promise<void>((resolve) => input.signal!.addEventListener('abort', () => resolve(), { once: true }))
          return { taskId: input.taskId, status: 'cancelled', output: '', changedFiles: [] }
        }
      })
      const exited = once(server, 'exit')
      server.start({ taskId: mode, agent: { ...agent, executionProtocol: 'acp' }, prompt: 'Wait', cwd: process.cwd() })
      if (mode === 'stop') server.cancel(mode)
      if (mode === 'shutdown') await server.close()
      const [result] = await exited as [ExitInfo]
      assert.equal(result.cancelled, mode === 'stop', 'Only an explicit Stop marks a server task cancelled')
      assert.notEqual(result.code, 0)
      await server.close()
    }

    const missing = once(agentProcesses, 'exit')
    agentProcesses.start({
      taskId: 'missing', agent: { ...agent, command: '/anvil-test-missing-agent' },
      prompt: 'Missing command', cwd: process.cwd()
    })
    const [missingExit] = await missing as [ExitInfo]
    assert.equal(missingExit.taskId, 'missing')
    assert.equal(missingExit.code, null)
    assert.match(missingExit.error!, /not installed or not on PATH/)
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
    assert.equal(((await shutdownExit) as [ExitInfo])[0].cancelled, false, 'App shutdown is an interruption, not a user cancellation')
    assert.equal(agentProcesses.isRunning('shutdown'), false)
    assert.throws(() => agentProcesses.start({ taskId: 'late', agent, prompt: 'Too late', cwd: process.cwd() }), /shutting down/)
    console.log('Agent process manager tests passed: task events, stream buffering, ANSI removal, cancellation, spawn failure, and awaited shutdown.')
  } finally {
    clearTimeout(timeout)
    await agentProcesses.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
