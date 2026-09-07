import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTracker, type BatchIssue, type Completion, type Issue } from 'valence'
import { taskIssueLabel } from '../src/shared/valence'

export const testHome = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-issue-tracker-test-')))
export const handlers = new Map<string, (...args: any[]) => any>()
export const app = { getPath: () => testHome, getAppPath: () => process.cwd() }
export const ipcMain = {
  handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
  on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler)
}
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('Use an explicit credential encryption test double') },
  decryptString: () => { throw new Error('Use an explicit credential encryption test double') }
}
export const dialog = {}
export const shell = {}
export class BrowserWindow {}
export const createProjectMemory = () => undefined
export const listModels = () => []
export class TerminalManager { dispose(): void {} }

export class AgentProcessManager extends EventEmitter {
  starts: any[] = []
  steering: { taskId: string; sessionId: string; message: string }[] = []
  async steer(input: { taskId: string; sessionId: string; message: string }): Promise<void> {
    if (!this.active.has(input.taskId)) throw new Error('No active turn')
    this.steering.push(input)
  }
  active = new Set<string>()
  isRunning(id: string): boolean { return this.active.has(id) }
  start(options: any): void {
    if (this.active.has(options.taskId)) throw new Error('Concurrent agent started')
    this.active.add(options.taskId)
    this.starts.push(options)
  }
  createPlan(taskId: string, inputs: BatchIssue[]): Issue[] {
    const tracker = openTracker(this.starts.findLast((start) => start.taskId === taskId).projectPath)
    try {
      return tracker.createMany(inputs.map((input) => ({ ...input, labels: [...(input.labels ?? []), taskIssueLabel(taskId)] })))
    } finally {
      tracker.close()
    }
  }
  plan(taskId: string, inputs: BatchIssue[]): void {
    this.createPlan(taskId, inputs)
    this.finishTurn(taskId, 'Plan created in Valence.')
  }
  completeIssue(taskId: string, issueId: string, completion: Completion): void {
    const tracker = openTracker(this.starts.findLast((start) => start.taskId === taskId).projectPath)
    try {
      tracker.complete(issueId, completion)
    } finally {
      tracker.close()
    }
    this.finishTurn(taskId, 'Completed through vl.')
  }
  finishTurn(taskId: string, text = 'Done.', code = 0): void {
    this.emit('event', { id: randomUUID(), taskId, ts: Date.now(), stream: 'stdout', kind: 'output', category: 'message', text })
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
  async getMergePreview(_path: string, branchName: string): Promise<any> {
    return { sourceBranch: branchName, targetBranch: 'main', sourceCommit: 'task-head', targetCommit: 'main-head', commitCount: 1 }
  }
  async merge(): Promise<void> {}
  async getDiff(_path: string, base: string, head: string): Promise<any> { return { patch: `${base}..${head}`, commits: [] } }
}
