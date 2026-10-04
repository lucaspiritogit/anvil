import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'
import { expect, test } from 'vitest'
import { AgentProcessManager } from '../apps/server/src/agents/process-manager'
import type { AgentExecutor, TaskEvent as ExecutorEvent, TaskInput, TaskResult } from '../apps/server/src/agents/agent-executor'
import type { AgentDefinition } from '@anvil/protocol/types'

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

const agents: Record<NonNullable<AgentDefinition['executionProtocol']>, AgentDefinition> = {
  acp: {
    id: 'opencode', label: 'OpenCode', description: 'Recording ACP executor fixture',
    command: 'unused', args: [], executionProtocol: 'acp'
  },
  'codex-app-server': {
    id: 'codex', label: 'Codex', description: 'Recording Codex executor fixture',
    command: 'unused', args: [], executionProtocol: 'codex-app-server'
  },
  'claude-code': {
    id: 'claude', label: 'Claude', description: 'Recording Claude executor fixture',
    command: 'unused', args: [], executionProtocol: 'claude-code'
  }
}

test('forwards explicit and omitted reasoning effort to each native protocol', async () => {
  const acpExecutor = new RecordingExecutor()
  const codexExecutor = new RecordingExecutor()
  const claudeExecutor = new RecordingExecutor()
  const agentProcesses = new AgentProcessManager(acpExecutor, codexExecutor, (agentId) => {
    expect(agentId).toBe('claude')
    return claudeExecutor
  })
  onTestCleanup(async () => {
    await agentProcesses.close()
    agentProcesses.removeAllListeners()
  })
  try {
    const exits: Promise<unknown>[] = []
    const run = (taskId: string, protocol: NonNullable<AgentDefinition['executionProtocol']>, reasoningEffort?: TaskInput['reasoningEffort']): void => {
      exits.push(new Promise<void>((resolve) => agentProcesses.once('exit', resolve)))
      agentProcesses.start({
        workspace: testWorkspace(),
        taskId,
        agent: agents[protocol],
        prompt: 'prompt',
        cwd: process.cwd(),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
      })
    }

    run('acp-level', 'acp', 'high')
    run('acp-native-effort', 'acp', 'native-max')
    run('codex-level', 'codex-app-server', 'native-max')
    run('acp-default', 'acp')
    run('codex-default', 'codex-app-server')
    run('claude-level', 'claude-code', 'xhigh')
    run('claude-default', 'claude-code')
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
    expect(claudeExecutor.inputs.map((input) => [input.taskId, input.reasoningEffort])).toStrictEqual([
      ['claude-level', 'xhigh'], ['claude-default', undefined]
    ])
    expect(claudeExecutor.inputs.every((input) => input.signal instanceof AbortSignal)).toBeTruthy()
  } finally {
    await agentProcesses.close()
  }
}, 30_000)
