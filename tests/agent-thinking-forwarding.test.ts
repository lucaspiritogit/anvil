import assert from 'node:assert/strict'
import { AgentProcessManager } from '../src/main/agents/process-manager'
import type { AgentExecutor, TaskEvent as ExecutorEvent, TaskInput, TaskResult } from '../src/main/agents/agent-executor'
import type { AgentDefinition } from '../src/shared/types'

class RecordingExecutor implements AgentExecutor {
  inputs: TaskInput[] = []
  async execute(input: TaskInput, onEvent: (event: ExecutorEvent) => void): Promise<TaskResult> {
    this.inputs.push(input)
    onEvent({ type: 'session', taskId: input.taskId, sessionId: 'session-1' })
    return {
      taskId: input.taskId,
      status: 'succeeded',
      output: 'done',
      changedFiles: []
    }
  }
}

const agent: AgentDefinition = {
  id: 'fixture', label: 'Fixture', description: 'Recording executor fixture',
  command: 'unused',
  args: []
}

async function main(): Promise<void> {
  const acpExecutor = new RecordingExecutor()
  const codexExecutor = new RecordingExecutor()
  const agentProcesses = new AgentProcessManager(acpExecutor, codexExecutor)
  try {
    const exits: Promise<unknown>[] = []
    const run = (taskId: string, thinkingLevel?: TaskInput['thinkingLevel'], protocol?: AgentDefinition['executionProtocol'], modelEffort?: string): void => {
      exits.push(new Promise<void>((resolve) => agentProcesses.once('exit', resolve)))
      agentProcesses.start({
        taskId,
        agent: { ...agent, executionProtocol: protocol },
        prompt: 'prompt',
        cwd: process.cwd(),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(modelEffort ? { modelEffort } : {})
      })
    }

    run('acp-level', 'high', 'acp')
    run('acp-native-effort', undefined, 'acp', 'max')
    run('codex-level', 'low', 'codex-app-server')
    run('acp-default', undefined, 'acp')
    run('codex-default', undefined, 'codex-app-server')
    await Promise.all(exits)

    assert.deepEqual(acpExecutor.inputs.map((input) => [input.taskId, input.thinkingLevel]), [
      ['acp-level', 'high'], ['acp-native-effort', undefined], ['acp-default', undefined]
    ])
    assert.deepEqual(codexExecutor.inputs.map((input) => [input.taskId, input.thinkingLevel]), [
      ['codex-level', 'low'], ['codex-default', undefined]
    ])
    assert.equal(acpExecutor.inputs.find((input) => input.taskId === 'acp-native-effort')?.modelEffort, 'max')
    assert.ok(acpExecutor.inputs.every((input) => input.signal instanceof AbortSignal))
    assert.ok(codexExecutor.inputs.every((input) => input.signal instanceof AbortSignal))
    console.log('Thinking-level forwarding tests passed: StartOptions reach both ACP and Codex executors, and omitted levels stay undefined.')
  } finally {
    await agentProcesses.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
