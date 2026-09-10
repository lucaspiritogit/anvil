import { randomBytes } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { CreateIssue, UpdateIssue, Completion } from '../../shared/valence'
import type { Store } from '../store'

export interface IssueToolConnection {
  url: string
  headers: Record<string, string>
  close(): void
}

const fields = {
  title: { type: 'string' }, description: { type: 'string' },
  checklist: { type: 'array', items: { type: 'string' } }, validation: { type: 'string' },
  labels: { type: 'array', items: { type: 'string' } },
  priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
  dependencies: { type: 'array', items: { type: 'string' } }
}
const id = { type: 'string', description: 'Issue ID from the current task plan.' }
export const ISSUE_TOOLS: Tool[] = [
  { name: 'anvil_get_plan', description: 'Read the current Anvil task, parent issue, execution phase and all its issues. Call this before resuming work.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'anvil_create_issue', description: 'Add a queued issue to the current task during planning. Parent and workspace are supplied by Anvil. Dependencies must belong to this task.', inputSchema: { type: 'object', properties: fields, required: ['title', 'description', 'checklist', 'validation'], additionalProperties: false } },
  { name: 'anvil_update_issue', description: 'Update an issue in the current task during planning. Ownership cannot change.', inputSchema: { type: 'object', properties: { id, patch: { type: 'object', properties: fields, additionalProperties: false } }, required: ['id', 'patch'], additionalProperties: false } },
  { name: 'anvil_submit_review', description: 'Submit the current working issue for developer review after validating and committing. Supply one true confirmation per checklist item and actual validation evidence. This does not approve the issue.', inputSchema: { type: 'object', properties: { id, checklist: { type: 'array', items: { type: 'boolean' } }, evidence: { type: 'string' } }, required: ['id', 'checklist', 'evidence'], additionalProperties: false } },
  { name: 'anvil_block_issue', description: 'Block an unfinished issue in the current task. Explain the blocker in your response.', inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false } },
  { name: 'anvil_requeue_issue', description: 'Requeue a blocked planning issue or the current interrupted issue. Never take over another task.', inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false } },
  { name: 'anvil_start_issue', description: 'Restart the current interrupted issue after requeueing it. Anvil schedules and claims new work.', inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false } }
]

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported argument: ${key}`)
}

/** Executes on Store's borrowed connection; agents never open a database. */
export function callIssueTool(store: Store, taskId: string, workspaceId: string, name: string, input: unknown): unknown {
  const definition = ISSUE_TOOLS.find((tool) => tool.name === name)
  if (!definition) throw new Error('Unknown issue tool')
  const args = object(input)
  keys(args, Object.keys(definition.inputSchema.properties ?? {}))
  for (const required of definition.inputSchema.required ?? []) if (!(required in args)) throw new Error(`Missing argument: ${required}`)
  return store.transaction(() => {
    const task = store.getTask(taskId)
    if (!task || task.workspaceId !== workspaceId) throw new Error('Task not found in the owning workspace')
    const state = store.getTaskExecution(taskId)
    if (!state) throw new Error('Task has no issue plan')
    const tracker = store.issueTracker(task.projectId, workspaceId)
    const parent = tracker.getParent(state.parentIssueId)
    if (parent.anvilTaskId !== taskId) throw new Error('Task does not own this plan')
    if (name === 'anvil_get_plan') return { task: { id: task.id, title: task.title, prompt: task.prompt }, parent, phase: state.phase, currentIssueId: state.currentIssueId, issues: tracker.list(parent.id) }
    const planning = state.phase === 'planning' || state.phase === 'blocked' && state.issueIds.length === 0
    const ownIssue = (value: unknown): string => {
      if (typeof value !== 'string') throw new Error('Issue ID must be a string')
      if (tracker.get(value).parentId !== parent.id) throw new Error('Issue belongs to another task')
      return value
    }
    const checkDependencies = (value: unknown): void => {
      if (value === undefined) return
      if (!Array.isArray(value)) throw new Error('Dependencies must be an array')
      for (const dependency of value) ownIssue(dependency)
    }
    if (name === 'anvil_create_issue') {
      if (!planning) throw new Error('Issues can only be created during planning')
      checkDependencies(args.dependencies)
      return tracker.create({ ...args, parentId: parent.id } as unknown as CreateIssue)
    }
    const issueId = ownIssue(args.id)
    if (name === 'anvil_update_issue') {
      if (!planning) throw new Error('Issues can only be edited during planning')
      const patch = object(args.patch)
      keys(patch, Object.keys(fields))
      checkDependencies(patch.dependencies)
      return tracker.update(issueId, patch as UpdateIssue)
    }
    const unblockingPlan = state.phase === 'recovering' && !state.currentIssueId &&
      state.issueIds.includes(issueId) && name === 'anvil_requeue_issue' && tracker.get(issueId).status === 'blocked'
    if (!planning && state.currentIssueId !== issueId && !unblockingPlan) {
      throw new Error('Only the current issue can be changed')
    }
    switch (name) {
      case 'anvil_block_issue': return tracker.block(issueId)
      case 'anvil_requeue_issue': return tracker.requeue(issueId)
      case 'anvil_start_issue':
        if (planning || state.currentIssueId !== issueId) throw new Error('Anvil must claim an issue before it can start')
        return tracker.start(issueId)
      case 'anvil_submit_review':
        if (planning || state.currentIssueId !== issueId) throw new Error('Only the current working issue can be submitted')
        return tracker.submitForReview(issueId, { checklist: args.checklist, evidence: args.evidence } as Completion)
      default: throw new Error('Unknown issue tool')
    }
  }, workspaceId)
}

interface TaskToolOwner {
  taskId: string
  workspaceId: string
  active: boolean
}

/** A stable task capability, enabled only while its agent is running. */
export class IssueToolServer {
  private readonly owners = new Map<string, TaskToolOwner>()
  private server?: HttpServer
  private starting?: Promise<string>
  private closed = false

  constructor(private readonly store: Store, private readonly changed: (taskId: string) => void = () => {}) {}

  private start(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Issue tools are closed'))
    if (this.starting) return this.starting
    this.starting = this.listen().catch((error) => {
      this.starting = undefined
      throw error
    })
    return this.starting
  }

  private async listen(): Promise<string> {
    const [{ Server }, { StreamableHTTPServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/index.js'),
      import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/types.js')
    ])
    if (this.closed) throw new Error('Issue tools are closed')
    const server = createServer((request, response) => {
      void (async () => {
        const authorization = request.headers.authorization ?? ''
        const owner = this.owners.get(authorization)
        if (!owner?.active || request.headers.origin || request.url !== '/mcp') {
          response.writeHead(403).end()
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { Allow: 'POST' }).end()
          return
        }
        const protocol = new Server({ name: 'anvil_issue_tracker', version: '1.0.0' }, { capabilities: { tools: {} } })
        protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ISSUE_TOOLS }))
        protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
          try {
            if (this.closed || !owner.active || this.owners.get(authorization) !== owner) throw new Error('Agent turn has ended')
            const result = callIssueTool(this.store, owner.taskId, owner.workspaceId, params.name, params.arguments ?? {})
            if (params.name !== 'anvil_get_plan') this.changed(owner.taskId)
            return { content: [{ type: 'text', text: JSON.stringify(result) }] }
          } catch (error) {
            return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
          }
        })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        response.on('close', () => { void protocol.close() })
        await protocol.connect(transport)
        await transport.handleRequest(request, response)
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
    this.server = server
    return new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Issue tools did not bind'))
          return
        }
        resolve(`http://127.0.0.1:${address.port}/mcp`)
      })
    })
  }

  async open(taskId: string): Promise<IssueToolConnection> {
    const task = this.store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    const url = await this.start()
    if (this.closed) throw new Error('Issue tools are closed')
    // Codex retains its MCP transport when a loaded thread resumes. Reuse the
    // task's credentials while this app is alive, but reject calls between turns.
    let entry = [...this.owners.entries()].find(([, owner]) => owner.taskId === taskId)
    if (!entry) {
      entry = [`Bearer ${randomBytes(32).toString('hex')}`, { taskId, workspaceId: task.workspaceId, active: false }]
      this.owners.set(...entry)
    }
    const [authorization, owner] = entry
    if (owner.active) throw new Error('Issue tools are already active for this task')
    if (owner.workspaceId !== task.workspaceId) throw new Error('Task workspace changed')
    owner.active = true
    let released = false
    return {
      url,
      headers: { Authorization: authorization },
      close: () => {
        if (released) return
        released = true
        owner.active = false
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.owners.clear()
    await this.starting?.catch(() => {})
    const server = this.server
    if (server?.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}
