import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { GitIdentity } from './git/command'

const execFileAsync = promisify(execFile)
const IDENTITY_TTL_MS = 60 * 60 * 1000

export interface GitIdentitySources {
  workspaces: () => { id: string; directory: string; projectPaths: string[] }[]
  token: (workspaceId: string) => Promise<string>
  identity: (token: string) => Promise<GitIdentity>
}

function contains(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return !path || !path.startsWith('..') && !isAbsolute(path)
}

async function configured(file: string, key: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--file', file, '--get', key], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })
    return Boolean(stdout.trim())
  } catch {
    return false
  }
}

export class WorkspaceGitIdentity {
  private readonly cache = new Map<string, { expires: number; identity: Promise<GitIdentity | undefined> }>()

  constructor(private readonly sources: GitIdentitySources) {}

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId)
  }

  async prepareAgentHome(workspaceId: string, directory: string): Promise<void> {
    const file = join(directory, 'home', '.gitconfig')
    if (!existsSync(file) || await configured(file, 'user.name') && await configured(file, 'user.email')) return
    await this.forWorkspace(workspaceId, directory)
  }

  forPath(cwd: string): Promise<GitIdentity | undefined> {
    const workspace = this.sources.workspaces().find((entry) =>
      contains(entry.directory, cwd) || entry.projectPaths.some((path) => contains(path, cwd)))
    return workspace ? this.forWorkspace(workspace.id, workspace.directory) : Promise.resolve(undefined)
  }

  forWorkspace(workspaceId: string, directory: string): Promise<GitIdentity | undefined> {
    const cached = this.cache.get(workspaceId)
    if (cached && cached.expires > Date.now()) return cached.identity
    const identity = this.resolve(workspaceId, directory)
    this.cache.set(workspaceId, { expires: Date.now() + IDENTITY_TTL_MS, identity })
    void identity.then((value) => { if (!value) this.cache.delete(workspaceId) })
    return identity
  }

  private async resolve(workspaceId: string, directory: string): Promise<GitIdentity | undefined> {
    let identity: GitIdentity
    try {
      identity = await this.sources.identity(await this.sources.token(workspaceId))
    } catch {
      return undefined
    }
    await this.seedAgentHome(join(directory, 'home', '.gitconfig'), identity).catch(() => {})
    return identity
  }

  private async seedAgentHome(file: string, identity: GitIdentity): Promise<void> {
    if (!existsSync(file)) return
    for (const [key, value] of [['user.name', identity.name], ['user.email', identity.email]] as const) {
      if (await configured(file, key)) continue
      await execFileAsync('git', ['config', '--file', file, key, value], { windowsHide: true, timeout: 5_000 })
    }
  }
}
