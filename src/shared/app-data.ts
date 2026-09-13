import { isAbsolute, join, normalize } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

/** Packaged app data stays in place; source runs and explicit test profiles are separate. */
export function resolveAppDataDirectory(home: string, isPackaged: boolean, override?: string): string {
  if (override) {
    if (!isAbsolute(override)) throw new Error('ANVIL_DATA_DIR must be an absolute path')
    return normalize(override)
  }
  return join(home, isPackaged ? '.anvil-composer' : '.anvil-composer-dev')
}

export function validateWorkspaceFolderName(name: string): void {
  if (!name.trim() || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw new Error('Workspace name must be a valid folder name')
  }
}

export function resolveWorkspaceDirectory(dataDirectory: string, name: string): string {
  validateWorkspaceFolderName(name)
  return join(dataDirectory, 'workspaces', name)
}

/** Maintenance defaults to development data and follows the selected workspace. */
export function selectedWorkspaceDirectory(dataDirectory = resolveAppDataDirectory(homedir(), false, process.env.ANVIL_DATA_DIR)): string {
  const filename = join(dataDirectory, 'config.json')
  if (!existsSync(filename)) return resolveWorkspaceDirectory(dataDirectory, 'Default')
  const config = JSON.parse(readFileSync(filename, 'utf8'))
  if (config.version !== 1 || !Array.isArray(config.workspaces)) throw new Error('Invalid root config')
  const workspace = config.workspaces.find((entry: { id: string }) => entry.id === config.activeWorkspaceId)
    ?? config.workspaces.find((entry: { id: string }) => entry.id === 'default')
  if (!workspace || typeof workspace.name !== 'string') throw new Error('Selected workspace not found')
  return resolveWorkspaceDirectory(dataDirectory, workspace.name)
}

export function workspaceDatabase(dataDirectory?: string): string {
  const override = process.env.ANVIL_DATABASE_PATH
  if (override) {
    if (!isAbsolute(override) || !override.endsWith('.db')) throw new Error('ANVIL_DATABASE_PATH must be an absolute workspace database path')
    return override
  }
  return join(selectedWorkspaceDirectory(dataDirectory), 'anvil.db')
}
