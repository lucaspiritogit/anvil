import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BatchIssue, Completion, Issue } from '@anvil/protocol/valence'
import { openTaskTracker as openIssueTracker } from './task-state'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { TaskToolConnection } from '../apps/server/src/agents/process-manager'

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
const agentInstances = new Set<AgentProcessManager>()
export class AgentProcessManager extends EventEmitter {
  constructor(private readonly databasePath?: string, _parse?: unknown, _executor?: unknown, _workspace?: unknown,
    private readonly openTaskTools?: (taskId: string) => Promise<TaskToolConnection>) {
    super()
    if (process.env.ANVIL_TEST_HOME) agentInstances.add(this)
  }
  async close(): Promise<void> {
    this.active.clear()
    this.removeAllListeners()
  }
  starts: any[] = []
  /** Simulate a tool call from the dispatched agent using its real IPC wiring. */
  async callTool(taskId: string, name: string, args: Record<string, unknown> = {}) {
    if (!this.active.has(taskId) || !this.openTaskTools) throw new Error('No active task tool connection')
    const connection = await this.openTaskTools(taskId)
    const server = connection.mcpServers.find((candidate) => candidate.name === 'anvil_issue_tracker')
    if (!server) throw new Error('No issue tool connection')
    const client = new Client({ name: 'task-agent-test', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }))
      return await client.callTool({ name, arguments: args })
    } finally {
      await connection.close()
      await client.close()
    }
  }
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
      const parentId = tracker.listParents().find((parent) => parent.anvilTaskId === taskId)?.id
      if (!parentId) throw new Error('Task has no Valence parent')
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
  finishTurn(taskId: string, text = 'Done.', code = 0, changedFiles: string[] = []): void {
    this.emit('event', { id: randomUUID(), taskId, ts: Date.now(), stream: 'stdout', kind: 'output', category: 'message', text })
    this.active.delete(taskId)
    this.emit('exit', {
      taskId,
      code,
      cancelled: false,
      result: { taskId, status: code === 0 ? 'succeeded' : 'pending', output: text, changedFiles }
    })
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
  async prepareBranch(_projectPath?: string, _taskId?: string, _check?: () => void, base?: { commit: string; branch: string }): Promise<any> {
    if (GitDeliveryManager.failPrepare) throw new Error('prepare failed')
    return { cwd: testHome, baseCommit: base?.commit ?? 'base', branchName: 'task', baseBranch: base?.branch ?? 'main' }
  }
  async checkoutBranch(): Promise<any> { return this.prepareBranch() }
  async resolveWorktreeBase(_projectPath: string, requested: string): Promise<any> {
    return { commit: `base-${requested}`, branch: requested }
  }
  async releaseWorktree(_projectPathOrTaskId: string, _taskId?: string, _expectedBranch?: string): Promise<void> {}
  async finalizeBranch(): Promise<any> {
    if (GitDeliveryManager.failFinalize) throw new Error('finalize failed')
    GitDeliveryManager.head++
    return { headCommit: GitDeliveryManager.currentHeadCommit(), hasChanges: true, filesChanged: 1, additions: 1, deletions: 0 }
  }
  async getMergePreview(_path: string, branchName: string): Promise<any> {
    const sourceCommit = GitDeliveryManager.currentHeadCommit()
    return { sourceBranch: branchName, targetBranch: 'main', sourceCommit, targetCommit: 'b'.repeat(40), commitCount: 1 }
  }
  async merge(): Promise<any> { return { status: 'merged', commit: 'd'.repeat(40) } }
  async getDiff(_path: string, base: string, head: string): Promise<any> { return { patch: `${base}..${head}`, commits: [] } }
  async getWorkingTreeDiff(_path: string, paths: string[]): Promise<any> {
    return {
      patch: paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`).join(''),
      commits: [], paths, filesChanged: paths.length, additions: paths.length, deletions: paths.length
    }
  }
  static worktreeHeadValue: string | null = null
  static currentHeadCommit(): string {
    if (GitDeliveryManager.worktreeHeadValue) return GitDeliveryManager.worktreeHeadValue
    if (GitDeliveryManager.head === 0) return 'a'.repeat(40)
    return GitDeliveryManager.head.toString(16).padStart(40, '0')
  }
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
  AgentProcessManager.prototype, GitDeliveryManager.prototype]
  .map((object) => [object, Object.getOwnPropertyDescriptors(object)] as const)
