// Adapted from @lpirito/valence 0.1.0, by lpirito. Maintained in Anvil.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { parentIssues, issues, issueDependencies, projects, tasks } from '../db/schema'
import { requiredText, validateIssueInput, validateParentInput } from './validation'
import type {
  ParentIssue, CreateParentIssue, UpdateParentIssue, Issue, CreateIssue, UpdateIssue,
  BatchIssue, IssueSelection, Completion
} from '../../shared/valence'

/** Project-scoped core over an already migrated Anvil database.
 * Borrowed connections belong to Store. CLI callers can transfer ownership by
 * passing 'owned' and must close the connection themselves if construction fails.
 */
export class IssueTracker {
  private readonly database: BetterSQLite3Database
  private closed = false

  constructor(
    private readonly connection: Database.Database,
    readonly projectId: string,
    private readonly ownership: 'borrowed' | 'owned' = 'borrowed'
  ) {
    requiredText(projectId, 'projectId')
    // BEGIN IMMEDIATE waits for other SQLite writers before reading claim candidates.
    connection.pragma('busy_timeout = 5000')
    connection.pragma('foreign_keys = ON')
    this.database = drizzle(connection)
    if (!this.database.select().from(projects).where(eq(projects.id, projectId)).get()) {
      throw new Error(`Project not found: ${projectId}`)
    }
  }

  private parentScope() {
    this.assertOpen()
    return inArray(parentIssues.anvilTaskId,
      this.database.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, this.projectId)))
  }

  private issueScope() {
    return inArray(issues.parentId,
      this.database.select({ id: parentIssues.id }).from(parentIssues).where(this.parentScope()))
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Issue tracker is closed')
  }

  get databasePath(): string {
    return this.connection.name
  }

  createParent(input: CreateParentIssue): ParentIssue {
    return this.database.transaction(() => {
      this.assertOpen()
      const parent = { ...validateParentInput(input), id: randomBytes(8).toString('hex') }
      if (!this.database.select().from(tasks).where(and(eq(tasks.id, parent.anvilTaskId), eq(tasks.projectId, this.projectId))).get())
        throw new Error(`Task not found: ${parent.anvilTaskId}`)
      this.database.insert(parentIssues).values(parent).run()
      return this.getParent(parent.id)
    }, { behavior: 'immediate' })
  }

  getParent(id: string): ParentIssue {
    const parent = this.database.select().from(parentIssues).where(and(eq(parentIssues.id, id), this.parentScope())).get()
    if (!parent)
      throw new Error(`Parent issue not found: ${id}`)
    const { sequence, ...result } = parent
    return result
  }

  listParents(): ParentIssue[] {
    return this.database.select().from(parentIssues).where(this.parentScope()).orderBy(parentIssues.sequence).all().map(({ sequence, ...parent }) => parent)
  }

  updateParent(id: string, patch: UpdateParentIssue): ParentIssue {
    return this.database.transaction(() => {
      const { anvilTaskId, title, description } = this.getParent(id)
      if (!patch || typeof patch !== 'object' || Array.isArray(patch))
        throw new Error('Expected a parent issue update object')
      if (Object.keys(patch).some((key) => !['title', 'description'].includes(key))) throw new Error('Unknown parent issue update field')
      const input = validateParentInput({ anvilTaskId, title, description, ...patch })
      this.database.update(parentIssues).set(input).where(eq(parentIssues.id, id)).run()
      return this.getParent(id)
    }, { behavior: 'immediate' })
  }

  create(input: CreateIssue): Issue {
    return this.createMany([{ ...validateIssueInput(input), key: randomBytes(8).toString('hex') }])[0]
  }

  /** Create a graph in input order, resolving batch keys to stable issue IDs. */
  createMany(inputs: BatchIssue[]): Issue[] {
    return this.database.transaction(() => {
      if (!Array.isArray(inputs) || !inputs.length)
        throw new Error('Expected a nonempty issue batch')
      const existing = new Map(this.list().map((issue) => [issue.id, issue]))
      const identifiers = new Map<string, string>()
      const batch = Array.from(inputs, (entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new Error('Expected a batch issue object')
        const { key, ...input } = entry
        const reference = requiredText(key, 'key')
        if (identifiers.has(reference))
          throw new Error('Issue keys must be unique')
        if (existing.has(reference))
          throw new Error('Issue keys must not shadow existing issue IDs')
        const id = randomBytes(8).toString('hex')
        identifiers.set(reference, id)
        const validated = validateIssueInput(input)
        this.getParent(validated.parentId)
        return { ...validated, id, status: 'queued' as const }
      })
      for (const issue of batch) {
        issue.dependencies = issue.dependencies.map((reference) => identifiers.get(reference) ?? reference)
      }

      const graph = new Map([...existing, ...batch.map((issue) => [issue.id, issue] as const)])
      const visited = new Set<string>()
      const visiting = new Set<string>()
      const visit = (id: string): void => {
        if (visiting.has(id))
          throw new Error('Issue dependencies must not contain cycles')
        if (visited.has(id))
          return
        const issue = graph.get(id)
        if (!issue)
          throw new Error(`Unknown issue dependency: ${id}`)
        if (issue.dependencies.includes(id))
          throw new Error('An issue cannot depend on itself')
        visiting.add(id)
        for (const dependency of issue.dependencies)
          visit(dependency)
        visiting.delete(id)
        visited.add(id)
      }

      for (const issue of batch)
        visit(issue.id)
      for (const { dependencies, ...issue } of batch)
        this.database.insert(issues).values(issue).run()
      for (const issue of batch) this.replaceDependencies(issue.id, issue.dependencies)
      return batch.map((issue) => this.get(issue.id))
    }, { behavior: 'immediate' })
  }

  update(id: string, patch: UpdateIssue): Issue {
    return this.database.transaction(() => {
      const current = this.get(id)
      if (current.status !== 'queued' && current.status !== 'blocked')
        throw new Error('Only queued or blocked issues can be updated')
      if (!patch || typeof patch !== 'object' || Array.isArray(patch))
        throw new Error('Expected an issue update object')
      const { parentId, title, description, checklist, validation, labels, priority, dependencies } = current
      const input = validateIssueInput({ parentId, title, description, checklist, validation, labels, priority, dependencies, ...patch })
      this.getParent(input.parentId)
      const existing = new Map(this.list().map((issue) => [issue.id, issue]))
      if (input.dependencies.includes(id))
        throw new Error('An issue cannot depend on itself')
      const visited = new Set<string>()
      const pending = [...input.dependencies]
      while (pending.length) {
        const dependencyId = pending.pop()!
        if (dependencyId === id)
          throw new Error('Issue dependencies must not contain cycles')
        if (visited.has(dependencyId))
          continue
        visited.add(dependencyId)
        const dependency = existing.get(dependencyId)
        if (!dependency)
          throw new Error(`Unknown issue dependency: ${dependencyId}`)
        pending.push(...dependency.dependencies)
      }

      const { dependencies: nextDependencies, ...fields } = input
      this.database.update(issues).set(fields).where(eq(issues.id, id)).run()
      this.replaceDependencies(id, nextDependencies)
      return this.get(id)
    }, { behavior: 'immediate' })
  }

  get(id: string): Issue {
    const row = this.database.select().from(issues).where(and(eq(issues.id, id), this.issueScope())).get()
    if (!row)
      throw new Error(`Issue not found: ${id}`)
    return this.toIssue(row)
  }

  list(parentId?: string): Issue[] {
    if (parentId !== undefined)
      parentId = this.getParent(requiredText(parentId, 'parentId')).id
    return this.database.select().from(issues).where(and(this.issueScope(), parentId === undefined ? undefined : eq(issues.parentId, parentId)))
      .orderBy(issues.sequence).all().map((row) => this.toIssue(row))
  }

  start(id: string): Issue {
    return this.database.transaction(() => {
      const issue = this.get(id)
      if (issue.status !== 'queued')
        throw new Error('Only queued issues can be started')
      const incomplete = issue.dependencies.filter((dependencyId) => this.get(dependencyId).status !== 'complete')
      if (incomplete.length)
        throw new Error(`Issue is blocked by incomplete dependencies: ${incomplete.join(', ')}`)
      this.database.update(issues).set({ status: 'working' }).where(eq(issues.id, id)).run()
      return this.get(id)
    }, { behavior: 'immediate' })
  }

  /** Claim the highest-priority ready issue, without racing other clients. */
  claim(selection?: IssueSelection): Issue | undefined {
    let selectedIds: Set<string> | undefined
    if (selection !== undefined) {
      if (!selection || (selection.ids === undefined && selection.parentId === undefined) ||
        (Object.hasOwn(selection, 'ids') && !Array.isArray(selection.ids)) ||
        Object.keys(selection).some((key) => !['ids', 'parentId'].includes(key))) {
        throw new Error('Claim selection must contain an ids array or parentId')
      }

      if (selection.ids !== undefined)
        selectedIds = new Set(Array.from(selection.ids, (id) => requiredText(id, 'id')))
    }

    return this.database.transaction(() => {
      if (selectedIds) for (const id of selectedIds) this.get(id)
      const issue = this.ready(selection?.parentId).find((candidate) => selectedIds === undefined || selectedIds.has(candidate.id))
      return issue ? this.start(issue.id) : undefined
    }, { behavior: 'immediate' })
  }

  /** Confirm the checklist with evidence and hold the issue for developer review. */
  submitForReview(id: string, completion: Completion): Issue {
    return this.database.transaction(() => {
      const issue = this.get(id)
      if (issue.status !== 'working')
        throw new Error('Only working issues can be submitted for review')
      if (!completion || !Array.isArray(completion.checklist) ||
        completion.checklist.length !== issue.checklist.length || !Array.from(completion.checklist).every((entry) => entry === true)) {
        throw new Error('Completion must confirm every checklist item with true')
      }

      const evidence = requiredText(completion.evidence, 'evidence')
      this.database.update(issues).set({
        status: 'review', evidence
      }).where(eq(issues.id, id)).run()
      return this.get(id)
    }, { behavior: 'immediate' })
  }

  /** Developer approval is the only path to complete; dependencies gate on it. */
  approve(id: string): Issue {
    return this.database.transaction(() => {
      const issue = this.get(id)
      if (issue.status !== 'review')
        throw new Error('Only issues in review can be approved')
      const now = Date.now()
      this.database.update(issues).set({
        status: 'complete', completedAt: now, reviewedAt: now
      }).where(eq(issues.id, id)).run()
      return this.get(id)
    }, { behavior: 'immediate' })
  }

  /** Send a review issue back to work; submitted evidence is no longer valid. */
  reject(id: string): Issue {
    return this.database.transaction(() => {
      const issue = this.get(id)
      if (issue.status !== 'review')
        throw new Error('Only issues in review can be rejected')
      this.database.update(issues).set({
        status: 'working', evidence: null
      }).where(eq(issues.id, id)).run()
      return this.get(id)
    }, { behavior: 'immediate' })
  }

  block(id: string): Issue {
    return this.database.transaction(() => {
      const issue = this.get(id)
      if (issue.status !== 'queued' && issue.status !== 'working' && issue.status !== 'review')
        throw new Error('Only queued, working, or review issues can be blocked')
      this.database.update(issues).set({ status: 'blocked' }).where(eq(issues.id, id)).run()
      return this.get(id)
    }, { behavior: 'immediate' })
  }

  requeue(id: string): Issue {
    return this.database.transaction(() => {
      const issue = this.get(id)
      if (issue.status !== 'working' && issue.status !== 'blocked' && issue.status !== 'review')
        throw new Error('Only working, blocked, or review issues can be requeued')
      this.database.update(issues).set({ status: 'queued' }).where(eq(issues.id, id)).run()
      return this.get(id)
    }, { behavior: 'immediate' })
  }

  ready(parentId?: string): Issue[] {
    if (parentId !== undefined)
      parentId = this.getParent(requiredText(parentId, 'parentId')).id
    const items = this.list()
    const completed = new Set(items.filter((issue) => issue.status === 'complete').map((issue) => issue.id))
    const priority = { urgent: 0, high: 1, medium: 2, low: 3 }
    return items.filter((issue) => (parentId === undefined || issue.parentId === parentId) &&
      issue.status === 'queued' && issue.dependencies.every((id) => completed.has(id)))
      .sort((first, second) => priority[first.priority] - priority[second.priority])
  }

  close(): void {
    if (this.closed)
      return
    if (this.ownership === 'owned') this.connection.close()
    this.closed = true
  }

  private replaceDependencies(id: string, dependencies: string[]): void {
    this.database.delete(issueDependencies).where(eq(issueDependencies.issueId, id)).run()
    dependencies.forEach((dependencyId, position) => {
      this.database.insert(issueDependencies).values({ issueId: id, dependencyId, position }).run()
    })
  }

  private toIssue(row: typeof issues.$inferSelect): Issue {
    const { sequence, evidence, completedAt, reviewedAt, ...issue } = row
    return {
      ...issue,
      dependencies: this.database.select().from(issueDependencies).where(eq(issueDependencies.issueId, row.id)).orderBy(issueDependencies.position).all().map((entry) => entry.dependencyId),
      ...(evidence === null ? {} : { evidence }),
      ...(completedAt === null ? {} : { completedAt }),
      ...(reviewedAt === null ? {} : { reviewedAt })
    }

  }
}
