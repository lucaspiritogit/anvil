import { randomBytes } from 'node:crypto'
import { createAdaptorServer, type HttpBindings, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { CreateIssue, UpdateIssue, Completion } from '@anvil/protocol/valence'
import type { Store } from '../store'
import { taskBranchNaming, type TaskBranches } from '../tasks/task-branch'

export interface IssueToolConnection {
  url: string
  headers: Record<string, string>
  close(): void
}

const fields = {
  title: { type: 'string' }, description: { type: 'string' },
  checklist: { type: 'array', items: { type: 'string' } }, validation: { type: 'string' },
  expectedFiles: { type: 'array', description: 'Repository-relative files this issue expects to modify.', items: { type: 'string' } },
  labels: { type: 'array', items: { type: 'string' } },
  priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
  dependencies: { type: 'array', items: { type: 'string' } }
}
const id = { type: 'string', description: 'Issue ID from anvil_get_plan or the supplied issue context; submission must use the currentIssueId.' }
const taskId = { type: 'string', description: 'Task ID in the current Anvil workspace.' }
const cursor = { type: 'integer', minimum: 0, description: 'Exclusive event sequence returned by a previous page.' }
const eventKinds = ['output', 'did_not_commit', 'delivery', 'message', 'thinking', 'tool_use', 'tool_result', 'system', 'error']
export const ISSUE_TOOLS: Tool[] = [
  { name: 'anvil_get_task', description: 'Read an Anvil task prompt, status, execution phase, issue summary, and task and issue commit references.', inputSchema: { type: 'object', properties: { taskId }, required: ['taskId'], additionalProperties: false } },
  { name: 'anvil_get_task_events', description: 'Read an ordered, paginated task event history. Use nextCursor to continue.', inputSchema: { type: 'object', properties: { taskId, cursor, kinds: { type: 'array', items: { type: 'string', enum: eventKinds }, uniqueItems: true }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 } }, required: ['taskId'], additionalProperties: false } },
  { name: 'anvil_search_task_output', description: 'Search task output text without loading the entire transcript. Results are ordered and paginated; use nextCursor to continue.', inputSchema: { type: 'object', properties: { taskId, query: { type: 'string', minLength: 1 }, cursor }, required: ['taskId', 'query'], additionalProperties: false } },
  { name: 'anvil_get_plan', description: 'Read the current Anvil task, branchName, canNameBranch eligibility, parent issue, execution phase and all its issues. Call this before resuming work.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'anvil_set_task_branch', description: 'Choose one descriptive Git branch name when anvil_get_plan reports task.canNameBranch. Anvil supplies task/workspace ownership, renames the managed checkout and saves the accepted name. Retry invalid or colliding choices; repeating the accepted name is safe. Established branches cannot be renamed.', inputSchema: { type: 'object', properties: { branchName: { type: 'string', description: 'Proposed literal short Git branch name, outside the reserved anvil-tmp/ namespace.' } }, required: ['branchName'], additionalProperties: false } },
  { name: 'anvil_create_issue', description: 'Add a queued issue to the current task during planning. Parent and workspace are supplied by Anvil. Dependencies must belong to this task.', inputSchema: { type: 'object', properties: fields, required: ['title', 'description', 'checklist', 'validation'], additionalProperties: false } },
  { name: 'anvil_update_issue', description: 'Update an issue in the current task during planning. Ownership cannot change.', inputSchema: { type: 'object', properties: { id, patch: { type: 'object', properties: fields, additionalProperties: false } }, required: ['id', 'patch'], additionalProperties: false } },
  { name: 'anvil_submit_review', description: 'Request completion of only the current issue in working status after validating and committing any changes. No empty commit is needed. Blocked issues must be requeued and started first. Success records the submission in review status, pending turn finalization. After the agent stops, Anvil verifies a clean worktree and finalized issue diff: empty changes complete automatically; changed work pauses for developer approval. This does not approve the issue.', inputSchema: { type: 'object', properties: { id, checklist: { type: 'array', description: 'Exactly one true confirmation per issue checklist item, in the order returned by anvil_get_plan. All items must be satisfied.', items: { type: 'boolean' } }, evidence: { type: 'string', description: 'Non-empty actual validation evidence: commands run and their results, plus any required manual checks. Never claim unperformed checks passed.' } }, required: ['id', 'checklist', 'evidence'], additionalProperties: false } },
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

function toolArguments(name: string, input: unknown): Record<string, unknown> {
  const definition = ISSUE_TOOLS.find((tool) => tool.name === name)
  if (!definition) throw new Error('Unknown issue tool')
  const args = object(input)
  keys(args, Object.keys(definition.inputSchema.properties ?? {}))
  for (const required of definition.inputSchema.required ?? []) if (!(required in args)) throw new Error(`Missing argument: ${required}`)
  return args
}

/** Executes on Store's borrowed connection; agents never open a database. */
export function callIssueTool(store: Store, taskId: string, workspaceId: string, name: string, input: unknown): unknown {
  if (name === 'anvil_set_task_branch') throw new Error('Task branch naming requires the asynchronous task tool service')
  const args = toolArguments(name, input)
  return store.transaction(() => {
    const task = store.getTask(taskId)
    if (!task || task.workspaceId !== workspaceId) throw new Error('Task not found in the owning workspace')
    if (name === 'anvil_get_task' || name === 'anvil_get_task_events' || name === 'anvil_search_task_output') {
      if (typeof args.taskId !== 'string') throw new Error('Task ID must be a string')
      const requested = store.getTask(args.taskId)
      if (!requested || requested.workspaceId !== workspaceId) throw new Error('Task not found in the owning workspace')
      const execution = store.getTaskExecution(requested.id)
      if (name === 'anvil_get_task') {
        const issues = execution ? store.issueTracker(requested.projectId, workspaceId).list(execution.parentIssueId) : []
        return {
          task: requested,
          execution: execution ? { phase: execution.phase, currentIssueId: execution.currentIssueId, error: execution.error } : null,
          issueSummary: {
            total: issues.length,
            byStatus: Object.fromEntries(['queued', 'working', 'blocked', 'review', 'complete'].map((status) => [status, issues.filter((issue) => issue.status === status).length])),
            issues: issues.map((issue) => ({ id: issue.id, title: issue.title, status: issue.status, baseCommit: issue.baseCommit, headCommit: issue.headCommit }))
          },
          commitReferences: { baseCommit: requested.baseCommit, headCommit: requested.headCommit }
        }
      }
      const parsedCursor = args.cursor === undefined ? 0 : args.cursor
      if (!Number.isSafeInteger(parsedCursor) || (parsedCursor as number) < 0) throw new Error('Cursor must be a non-negative integer')
      if (name === 'anvil_search_task_output') {
        if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('Query must be a non-empty string')
        return store.readTaskOutput(requested.id, { cursor: parsedCursor as number, limit: 50, query: args.query })
      }
      const limit = args.limit === undefined ? 100 : args.limit
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new Error('Limit must be an integer from 1 to 200')
      if (args.kinds !== undefined && (!Array.isArray(args.kinds) || args.kinds.some((kind) => typeof kind !== 'string' || !eventKinds.includes(kind)))) throw new Error('Invalid event kind')
      return store.readTaskOutput(requested.id, { cursor: parsedCursor as number, limit: limit as number, kinds: args.kinds as string[] | undefined })
    }
    const state = store.getTaskExecution(taskId)
    if (!state) throw new Error('Task has no issue plan')
    const tracker = store.issueTracker(task.projectId, workspaceId)
    const parent = tracker.getParent(state.parentIssueId)
    if (parent.anvilTaskId !== taskId) throw new Error('Task does not own this plan')
    if (name === 'anvil_get_plan') return { task: { id: task.id, title: task.title, prompt: task.prompt, ...taskBranchNaming(task) }, parent, phase: state.phase, currentIssueId: state.currentIssueId, issues: tracker.list(parent.id) }
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
        return {
          ...tracker.submitForReview(issueId, { checklist: args.checklist, evidence: args.evidence } as Completion),
          completion: 'pending_finalization',
          message: 'Submission recorded. End this turn so Anvil can finalize changes. Verified empty changes complete automatically; changed work requires developer review.'
        }
      default: throw new Error('Unknown issue tool')
    }
  }, workspaceId)
}

interface TaskToolOwner {
  taskId: string
  workspaceId: string
  active: boolean
  turn: number
}

/** A stable task capability, enabled only while its agent is running. */
export class IssueToolServer {
  private readonly owners = new Map<string, TaskToolOwner>()
  private readonly branchCalls = new Set<Promise<unknown>>()
  private server?: ServerType
  private starting?: Promise<string>
  private closed = false

  constructor(
    private readonly store: Store,
    private readonly changed: (taskId: string) => void = () => {},
    private readonly branches?: Pick<TaskBranches, 'set'>
  ) {}

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
    const [{ Server }, { WebStandardStreamableHTTPServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/index.js'),
      import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'),
      import('@modelcontextprotocol/sdk/types.js')
    ])
    if (this.closed) throw new Error('Issue tools are closed')
    const app = new Hono<{ Bindings: HttpBindings }>()
    app.use('*', async (context, next) => {
      const owner = this.owners.get(context.req.header('authorization') ?? '')
      if (!owner?.active || context.req.header('origin') || context.env.incoming.url !== '/mcp') {
        return context.body(null, 403)
      }
      if (context.req.method !== 'POST') {
        context.header('Allow', 'POST')
        return context.body(null, 405)
      }
      await next()
    })
    app.post('/mcp', async (context) => {
      const authorization = context.req.header('authorization') ?? ''
      const owner = this.owners.get(authorization)
      if (!owner?.active) return context.body(null, 403)
      const turn = owner.turn
      const checkTurn = (): void => {
        if (this.closed || !owner.active || owner.turn !== turn || this.owners.get(authorization) !== owner) throw new Error('Agent turn has ended')
      }
      const protocol = new Server({ name: 'anvil_issue_tracker', version: '1.0.0' }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ISSUE_TOOLS }))
      protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        try {
          checkTurn()
          const args = toolArguments(params.name, params.arguments ?? {})
          let result: unknown
          if (params.name === 'anvil_set_task_branch') {
            if (!this.branches) throw new Error('Task branch naming is unavailable')
            if (typeof args.branchName !== 'string') throw new Error('Branch name must be a string')
            const call = this.branches.set(owner.taskId, owner.workspaceId, args.branchName, checkTurn)
            this.branchCalls.add(call)
            try { result = await call }
            finally { this.branchCalls.delete(call) }
          } else {
            result = callIssueTool(this.store, owner.taskId, owner.workspaceId, params.name, args)
            if (!['anvil_get_plan', 'anvil_get_task', 'anvil_get_task_events', 'anvil_search_task_output'].includes(params.name)) this.changed(owner.taskId)
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        }
      })
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      context.env.outgoing.once('close', () => { void protocol.close() })
      await protocol.connect(transport)
      return transport.handleRequest(context.req.raw)
    })
    app.onError((_, context) => context.body(null, 500))
    const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })
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
      entry = [`Bearer ${randomBytes(32).toString('hex')}`, { taskId, workspaceId: task.workspaceId, active: false, turn: 0 }]
      this.owners.set(...entry)
    }
    const [authorization, owner] = entry
    if (owner.active) throw new Error('Issue tools are already active for this task')
    if (owner.workspaceId !== task.workspaceId) throw new Error('Task workspace changed')
    owner.active = true
    owner.turn++
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
        if ('closeAllConnections' in server) server.closeAllConnections()
      })
    }
    // Closing HTTP connections does not stop asynchronous Git work. Let any
    // mutation reconcile its saved name before the application closes Store.
    await Promise.allSettled([...this.branchCalls])
  }
}
