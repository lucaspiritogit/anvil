import { testWorkspace } from './workspace-fixture'
import { expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { draftCommitMessage } from '../src/server/agents/commit-message-draft'
import type { Task, TaskDiff } from '../src/shared/types'

test('drafts a commit message from the working-tree diff with validation and cleanup', async () => {
  const prompts: string[] = []
  const cwds: string[] = []
  let output = 'fix: clamp output rows'
  let fail = false
  const agentProcesses = {
    async generateText(options: { prompt: string; cwd: string }): Promise<string> {
      prompts.push(options.prompt)
      cwds.push(options.cwd)
      if (fail) throw new Error('Draft failed')
      return output
    }
  }
  const task = { workspaceId: 'default', id: 'task', agentId: 'codex', model: 'chosen-model', prompt: 'Clamp the output rows' } as Task
  const diff: TaskDiff = { patch: '+changed line', commits: [] }

  expect(await draftCommitMessage(agentProcesses, testWorkspace(), task, diff, 'Old message', 'high')).toBe('fix: clamp output rows')
  expect(prompts[0]).toContain('commit message')
  expect(prompts[0]).toContain('+changed line')
  expect(prompts[0]).toContain('Old message')
  expect(prompts[0]).toContain('Clamp the output rows')
  expect(existsSync(cwds[0]), 'Remove temporary drafting directories').toBe(false)

  output = ' '
  await expect(draftCommitMessage(agentProcesses, testWorkspace(), task, diff, '')).rejects.toThrow(/invalid commit message/)
  fail = true
  await expect(draftCommitMessage(agentProcesses, testWorkspace(), task, diff, '')).rejects.toThrow(/Draft failed/)
  expect(cwds.every((cwd) => !existsSync(cwd)), 'Cleanup also runs after failures').toBe(true)

  await expect(draftCommitMessage(agentProcesses, testWorkspace('other'), task, diff, '')).rejects.toThrow(/does not match/)
})
