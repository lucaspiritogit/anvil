import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceExecutionContext } from './workspace-execution'

export function claudeWorkspaceEnvironment(
  workspace: WorkspaceExecutionContext,
  platform: NodeJS.Platform = process.platform
): Readonly<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    ...workspace.environment,
    CLAUDE_CONFIG_DIR: workspace.claudeHome
  }
  if (platform === 'darwin') {
    const nativeHome = userInfo().homedir
    environment.HOME = nativeHome
    environment.USERPROFILE = nativeHome
    environment.GIT_CONFIG_GLOBAL = join(workspace.home, '.gitconfig')
  }
  return Object.freeze(environment)
}
