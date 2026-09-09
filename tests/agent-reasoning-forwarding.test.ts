import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'
import { expect, test } from 'vitest'
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

test('forwards explicit and omitted reasoning effort to both protocols', async () => {
  const acpExecutor = new RecordingExecutor()
  const codexExecutor = new RecordingExecutor()
  const agentProcesses = new AgentProcessManager(acpExecutor, codexExecutor)
  onTestCleanup(async () => {
    await agentProcesses.close()
    agentProcesses.removeAllListeners()
  })
  try {
    const exits: Promise<unknown>[] = []
    const run = (taskId: string, reasoningEffort?: TaskInput['reasoningEffort'], protocol?: AgentDefinition['executionProtocol']): void => {
      exits.push(new Promise<void>((resolve) => agentProcesses.once('exit', resolve)))
      agentProcesses.start({
        workspace: testWorkspace(),
        taskId,
        agent: { ...agent, executionProtocol: protocol },
        prompt: 'prompt',
        cwd: process.cwd(),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
      })
    }

    run('acp-level', 'high', 'acp')
    run('acp-native-effort', 'native-max', 'acp')
    run('codex-level', 'native-max', 'codex-app-server')
    run('acp-default', undefined, 'acp')
    run('codex-default', undefined, 'codex-app-server')
    await Promise.all(exits)

    expect(acpExecutor.inputs.map((input) => [input.taskId, input.reasoningEffort])).toStrictEqual([
      ['acp-level', 'high'], ['acp-native-effort', 'native-max'], ['acp-default', undefined]
    ])
    expect(codexExecutor.inputs.map((input) => [input.taskId, input.reasoningEffort])).toStrictEqual([
      ['codex-level', 'native-max'], ['codex-default', undefined]
    ])
    expect(acpExecutor.inputs.find((input) => input.taskId === 'acp-native-effort')?.reasoningEffort).toBe('native-max')
    expect(acpExecutor.inputs.every((input) => input.signal instanceof AbortSignal)).toBeTruthy()
    expect(codexExecutor.inputs.every((input) => input.signal instanceof AbortSignal)).toBeTruthy()
  } finally {
    await agentProcesses.close()
  }
}, 30_000)
