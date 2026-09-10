import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BatchIssue, Completion, Issue } from '../src/shared/valence'
import { openTaskTracker as openIssueTracker } from './task-state'

export const testHome = process.env.ANVIL_TEST_HOME ?? realpathSync(mkdtempSync(join(tmpdir(), 'anvil-issue-tracker-test-')))
export const handlers = new Map<string, (...args: any[]) => any>()
export const app = { isPackaged: true, getPath: () => testHome, getAppPath: () => process.cwd() }
export const powerSaveBlocker = { start: () => 0, stop: () => true }
export class Notification {
  static isSupported(): boolean { return false }
}
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
export const invalidateWorkspaceModels = () => {}
export const closeModelDiscovery = async () => {}
export class TerminalManager {
  dispose(): void {}
  disposeAll(): void {}
}

const agentInstances = new Set<AgentProcessManager>()
export class AgentProcessManager extends EventEmitter {
  constructor(private readonly databasePath?: string) {
    super()
    if (process.env.ANVIL_TEST_HOME) agentInstances.add(this)
  }
  async close(): Promise<void> {
    this.active.clear()
    this.removeAllListeners()
  }
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
  createPlan(taskId: string, inputs: Omit<BatchIssue, 'parentId'>[]): Issue[] {
    const tracker = openIssueTracker(this.starts.findLast((start) => start.taskId === taskId).projectPath, this.starts.findLast((start) => start.taskId === taskId).workspace ? join(this.starts.findLast((start) => start.taskId === taskId).workspace.directory, 'anvil.db') : this.databasePath)
    try {
      const prompt = this.starts.findLast((start) => start.taskId === taskId).prompt as string
      const parentId = /Create issues under parent "([^"]+)"/.exec(prompt)?.[1]
      if (!parentId) throw new Error('Planning prompt has no Valence parent')
      return tracker.createMany(inputs.map((input) => ({ ...input, parentId })))
    } finally {
      tracker.close()
    }
  }
  plan(taskId: string, inputs: Omit<BatchIssue, 'parentId'>[]): void {
    this.createPlan(taskId, inputs)
    this.finishTurn(taskId, 'Plan created in Valence.')
  }
  completeIssue(taskId: string, issueId: string, completion: Completion): void {
    const tracker = openIssueTracker(this.starts.findLast((start) => start.taskId === taskId).projectPath, this.starts.findLast((start) => start.taskId === taskId).workspace ? join(this.starts.findLast((start) => start.taskId === taskId).workspace.directory, 'anvil.db') : this.databasePath)
    try {
      tracker.submitForReview(issueId, completion)
      tracker.approve(issueId)
    } finally {
      tracker.close()
    }
    this.finishTurn(taskId, 'Completed through the issue tool.')
  }
  finishTurn(taskId: string, text = 'Done.', code = 0): void {
    this.emit('event', { id: randomUUID(), taskId, ts: Date.now(), stream: 'stdout', kind: 'output', category: 'message', text })
    this.active.delete(taskId)
    this.emit('exit', { taskId, code, cancelled: false })
  }
  async startResumed(opts: any): Promise<void> {
    opts.beforeDispatch?.()
    this.start(opts)
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
  async prepareBranch(): Promise<any> {
    if (GitDeliveryManager.failPrepare) throw new Error('prepare failed')
    return { cwd: testHome, baseCommit: 'base', branchName: 'task', baseBranch: 'main' }
  }
  async checkoutBranch(): Promise<any> { return this.prepareBranch() }
  async releaseWorktree(): Promise<void> {}
  async finalizeBranch(): Promise<any> {
    if (GitDeliveryManager.failFinalize) throw new Error('finalize failed')
    return { headCommit: `commit-${++GitDeliveryManager.head}`, hasChanges: true, filesChanged: 1, additions: 1, deletions: 0 }
  }
  async getMergePreview(_path: string, branchName: string): Promise<any> {
    return { sourceBranch: branchName, targetBranch: 'main', sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), commitCount: 1 }
  }
  async merge(): Promise<void> {}
  async getDiff(_path: string, base: string, head: string): Promise<any> { return { patch: `${base}..${head}`, commits: [] } }
  static worktreeHeadValue: string | null = null
  worktreeHead(): string | null { return GitDeliveryManager.worktreeHeadValue }
  async getIssueDiff(_path: string, source: any): Promise<any> {
    if (source.baseCommit && source.headCommit) return { patch: `${source.baseCommit}..${source.headCommit}`, commits: [] }
    if (source.taskBaseCommit && source.taskHeadCommit) return { patch: `${source.taskBaseCommit}..${source.taskHeadCommit}`, commits: [] }
    return null
  }
}

export function resetTestDoubles(): void {
  handlers.clear()
  GitDeliveryManager.repository = true
  GitDeliveryManager.failFinalize = false
  GitDeliveryManager.failPrepare = false
  GitDeliveryManager.head = 0
  GitDeliveryManager.worktreeHeadValue = null
  for (const agent of agentInstances) {
    agent.removeAllListeners()
    agent.active.clear()
    agent.starts.length = 0
    agent.steering.length = 0
  }
  agentInstances.clear()
  for (const [object, descriptors] of doubleDefaults) {
    for (const key of Reflect.ownKeys(object)) {
      if (!(key in descriptors)) Reflect.deleteProperty(object, key)
    }
    Object.defineProperties(object, descriptors)
  }
}

const doubleDefaults = [app, powerSaveBlocker, ipcMain, safeStorage, dialog, shell,
  AgentProcessManager.prototype, GitDeliveryManager.prototype, TerminalManager.prototype]
  .map((object) => [object, Object.getOwnPropertyDescriptors(object)] as const)
