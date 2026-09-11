import { join } from 'node:path'
import { resolveWorkspaceExecution, type WorkspaceExecutionContext } from '../src/server/agents/workspace-execution'

/** Profiles live under the suite's temporary home and are removed by Vitest setup. */
export function testWorkspace(workspaceId = 'default'): WorkspaceExecutionContext {
  const home = process.env.ANVIL_TEST_HOME
  if (!home) throw new Error('Workspace fixtures require the Vitest temporary home')
  return resolveWorkspaceExecution({ getWorkspaceDirectory: (id) => join(home, 'agent-profiles', id) }, workspaceId)
}
