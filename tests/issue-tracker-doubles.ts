import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const testHome = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-issue-tracker-test-')))
export const handlers = new Map<string, (...args: any[]) => any>()
export const app = { getPath: () => testHome, getAppPath: () => process.cwd() }
export const ipcMain = {
  handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
  on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler)
}
export const dialog = {}
export const shell = {}
export class BrowserWindow {}
export const createProjectMemory = () => undefined
export const listModels = () => []
export class TerminalManager { dispose(): void {} }

export class AgentProcessManager extends EventEmitter {
  starts: any[] = []
  active = new Set<string>()
  isRunning(id: string): boolean { return this.active.has(id) }
  start(options: any): void {
    if (this.active.has(options.taskId)) throw new Error('Concurrent agent started')
    this.active.add(options.taskId)
    this.starts.push(options)
  }
  result(taskId: string, payload: unknown, code = 0): void {
    this.emit('event', { id: randomUUID(), taskId, ts: Date.now(), stream: 'stdout', kind: 'output', category: 'message', text: `<task-result>${JSON.stringify(payload)}</task-result>` })
    this.active.delete(taskId)
    this.emit('exit', { taskId, code, cancelled: false })
  }
  cancel(taskId: string): boolean {
    this.active.delete(taskId)
    this.emit('exit', { taskId, code: null, cancelled: true })
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
