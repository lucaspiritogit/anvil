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

const WINDOWS_DESKTOP_VARIABLE = /^(USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|ALLUSERSPROFILE|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|PUBLIC|OS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|PROCESSOR_LEVEL|PROCESSOR_REVISION|NUMBER_OF_PROCESSORS|COMPUTERNAME|USERDOMAIN|USERDOMAIN_ROAMINGPROFILE|SESSIONNAME|DRIVERDATA)$/i

export function claudeAuthEnvironment(
  workspace: WorkspaceExecutionContext,
  platform: NodeJS.Platform = process.platform,
  inherited: NodeJS.ProcessEnv = process.env
): Readonly<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = { ...claudeWorkspaceEnvironment(workspace, platform) }
  if (platform === 'win32') {
    for (const key of Object.keys(environment)) {
      if (WINDOWS_DESKTOP_VARIABLE.test(key)) delete environment[key]
    }
    for (const [key, value] of Object.entries(inherited)) {
      if (WINDOWS_DESKTOP_VARIABLE.test(key) && value !== undefined) environment[key] = value
    }
    if (!Object.keys(environment).some((key) => key.toUpperCase() === 'USERPROFILE')) environment.USERPROFILE = userInfo().homedir
  }
  return Object.freeze(environment)
}
