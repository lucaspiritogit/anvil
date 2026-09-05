import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const testHome = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-issue-tracker-test-')))
export const handlers = new Map<string, (...args: any[]) => any>()
export const app = { getPath: () => testHome, getAppPath: () => process.cwd() }
export const ipcMain = { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), on: () => {} }
export const dialog = {}
export const shell = {}
export class BrowserWindow {}
export const createProjectMemory = () => undefined
export const listModels = () => []
export class TerminalManager { dispose(): void {} }

export class AgentRunner extends EventEmitter {
  starts: any[] = []
  active = new Set<string>()
  isRunning(id: string): boolean { return this.active.has(id) }
  start(options: any): void {
    if (this.active.has(options.runId)) throw new Error('Concurrent agent started')
    this.active.add(options.runId)
    this.starts.push(options)
  }
  result(runId: string, payload: unknown, code = 0): void {
    this.emit('event', { id: randomUUID(), runId, ts: Date.now(), stream: 'stdout', kind: 'output', category: 'message', text: `<anvil-issue-tracker>${JSON.stringify(payload)}</anvil-issue-tracker>` })
    this.active.delete(runId)
    this.emit('exit', { runId, code, cancelled: false })
  }
  cancel(runId: string): boolean {
    this.active.delete(runId)
    this.emit('exit', { runId, code: null, cancelled: true })
    return true
  }
}

export class GitDeliveryManager {
  static repository = true
  static failFinalize = false
  static failPrepare = false
  static head = 0
  async status(): Promise<any> { return { isRepository: GitDeliveryManager.repository, gitAvailable: true } }
  async prepare(): Promise<any> {
    if (GitDeliveryManager.failPrepare) throw new Error('prepare failed')
    return { cwd: testHome, worktreePath: testHome, baseCommit: 'base', branchName: 'task', baseBranch: 'main' }
  }
  async reopen(): Promise<any> { return this.prepare() }
  async finalize(): Promise<any> {
    if (GitDeliveryManager.failFinalize) throw new Error('finalize failed')
    return { headCommit: `commit-${++GitDeliveryManager.head}`, hasChanges: true, filesChanged: 1, additions: 1, deletions: 0 }
  }
  async getDiff(_path: string, base: string, head: string): Promise<any> { return { patch: `${base}..${head}`, commits: [] } }
}
