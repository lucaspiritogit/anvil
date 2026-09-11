import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_WORKSPACE_ID, MAX_WORKSPACE_NAME_LENGTH, type Workspace } from '../shared/types'
import { validateWorkspaceFolderName } from './workspace-directories'

export interface RootConfig {
  version: 1
  workspaces: Workspace[]
  activeWorkspaceId: string
}

export function normalizeWorkspaceName(value: string): { name: string; nameKey: string } {
  if (typeof value !== 'string') throw new Error('Workspace name must be a string')
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!name || name.length > MAX_WORKSPACE_NAME_LENGTH || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`Workspace name must contain 1 to ${MAX_WORKSPACE_NAME_LENGTH} characters without control characters`)
  }
  validateWorkspaceFolderName(name)
  return { name, nameKey: name.toLowerCase() }
}

export function readRootConfig(filename: string): RootConfig {
  const value = JSON.parse(readFileSync(filename, 'utf8')) as Partial<RootConfig> | null
  if (!value || value.version !== 1 || !Array.isArray(value.workspaces) || !value.workspaces.length) {
    throw new Error('Invalid root config')
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const workspace of value.workspaces) {
    if (!workspace || typeof workspace.id !== 'string' || !/^(default|[0-9a-f-]{36})$/.test(workspace.id)
      || !Number.isFinite(workspace.createdAt)) throw new Error('Invalid workspace in root config')
    const normalized = normalizeWorkspaceName(workspace.name)
    if (normalized.name !== workspace.name || ids.has(workspace.id) || names.has(normalized.nameKey)) {
      throw new Error('Duplicate or invalid workspace in root config')
    }
    ids.add(workspace.id)
    names.add(normalized.nameKey)
  }
  if (!ids.has(DEFAULT_WORKSPACE_ID)) throw new Error('Default workspace missing from root config')
  return {
    version: 1,
    workspaces: value.workspaces,
    activeWorkspaceId: typeof value.activeWorkspaceId === 'string' && ids.has(value.activeWorkspaceId)
      ? value.activeWorkspaceId : DEFAULT_WORKSPACE_ID
  }
}

/** Publish a complete file so readers never see a partially written selection. */
export function writeRootConfig(filename: string, config: RootConfig): void {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true })
    renameSync(temporary, filename)
  } finally {
    if (existsSync(temporary)) rmSync(temporary)
  }
}
