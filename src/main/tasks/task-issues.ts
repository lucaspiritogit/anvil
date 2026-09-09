import type { Issue } from '../../shared/valence'
import type { IssueTracker } from '../valence/tracker'
import type { TaskExecutionState, TaskIssueSnapshot } from '../../shared/types'
import type { Store } from '../store'

/** Runs task-owned Valence plans on the Store connection. */
export class TaskIssues {
  private readonly ownedClaims = new Map<string, string>()

  constructor(private readonly store: Store) {}

  initialize(taskId: string, projectPath: string): TaskExecutionState {
    return this.store.transaction(() => {
      const task = this.store.getTask(taskId)
      if (!task) throw new Error('Task not found')
      const project = this.store.getProjects().find((entry) => entry.id === task.projectId)
      if (project?.path !== projectPath) throw new Error('Task project does not match execution project')
      const existing = this.store.getTaskExecution(taskId)
      if (existing) return this.withTracker(existing, () => existing)
      const tracker = this.store.issueTracker(task.projectId)
      try {
        const parent = tracker.listParents().find((entry) => entry.anvilTaskId === taskId)
          ?? tracker.createParent({ anvilTaskId: taskId, title: task.title, description: task.prompt })
        return this.store.saveTaskExecution({
          taskId, projectPath, parentIssueId: parent.id, phase: 'planning', issueIds: [], currentIssueId: null,
          error: null
        })
      } finally {
        tracker.close()
      }
    })
  }

  finishPlanning(taskId: string): void {
    const state = this.requireState(taskId)
    if (state.phase !== 'planning' || state.issueIds.length) throw new Error('This task already has a plan')
    this.withTracker(state, (tracker) => {
      const issues = tracker.list(state.parentIssueId)
      if (issues.some((issue) => issue.status !== 'queued')) throw new Error('Every planned issue must be queued in Valence')
      // Snapshot the plan's IDs so later additions cannot expand the running task.
      this.store.saveTaskExecution({
        ...state, phase: issues.length ? 'working' : 'complete', issueIds: issues.map((issue) => issue.id)
      })
    })
  }

  claim(taskId: string, baseCommit?: string): Issue | undefined {
    const claimed = this.store.transaction(() => {
      const state = this.requireState(taskId)
      if (state.phase !== 'working' || state.currentIssueId) throw new Error('Task is not ready to claim work')
      return this.withTracker(state, (tracker) => {
        const issue = tracker.claim({ ids: state.issueIds, parentId: state.parentIssueId })
        if (issue) {
          // A re-claimed rework keeps its original base; only a first claim records one.
          const started = baseCommit && !issue.baseCommit
            ? tracker.recordCommits(issue.id, { baseCommit })
            : issue
          this.store.saveTaskExecution({ ...state, currentIssueId: started.id })
          return started
        }
        return issue
      })
    })
    if (claimed) this.ownedClaims.set(taskId, claimed.id)
    return claimed
  }

  list(taskId: string): Issue[] {
    const state = this.requireState(taskId)
    return this.withTracker(state, (tracker) => state.issueIds.map((id) => tracker.get(id)))
  }

  /** Null means an existing task has no Valence association yet. Errors are not empty plans. */
  snapshot(taskId: string): TaskIssueSnapshot | null {
    if (!this.store.getTask(taskId)) throw new Error('Task not found')
    const state = this.store.getTaskExecution(taskId)
    if (!state) return null
    // Resolve ownership from the persisted task, never renderer-supplied identities.
    return this.withTracker(state, (tracker) => ({
      parent: tracker.getParent(state.parentIssueId),
      children: tracker.list(state.parentIssueId)
    }))
  }

  finishIssue(taskId: string, headCommit?: string): void {
    const state = this.requireState(taskId)
    if (!state.currentIssueId) throw new Error('No issue is currently running')
    this.withTracker(state, (tracker) => {
      const issue = tracker.get(state.currentIssueId!)
      this.recordReviewCommit(tracker, issue, headCommit)
      if (issue.status !== 'complete') {
        throw new Error(issue.status === 'review'
          ? `Issue ${issue.id} is awaiting developer review in Valence. Approve it to continue the task.`
          : `Issue ${issue.id} is ${issue.status} in Valence, not complete. The agent must complete it through vl.`)
      }
      // Valence already validated the checklist and evidence. Never infer success from text.
      const complete = state.issueIds.every((id) => tracker.get(id).status === 'complete')
      this.store.saveTaskExecution({ ...state, currentIssueId: null, phase: complete ? 'complete' : 'working', error: null })
    })
    this.ownedClaims.delete(taskId)
  }

  /** User follow-ups can recover a stopped turn without discarding its issue plan. */
  resume(taskId: string): TaskExecutionState {
    const state = this.requireState(taskId)
    return this.withTracker(state, () => {
      if (state.phase === 'complete') return state
      return this.store.saveTaskExecution({
        ...state, phase: state.issueIds.length ? 'recovering' : 'planning', error: null
      })
    })
  }

  finishRecovery(taskId: string, headCommit?: string): void {
    const state = this.requireState(taskId)
    this.withTracker(state, (tracker) => {
      // A user message must not bypass the original checklist or finish work
      // based on an assistant's claim. Valence remains authoritative.
      const current = state.currentIssueId ? tracker.get(state.currentIssueId) : undefined
      if (current) this.recordReviewCommit(tracker, current, headCommit)
      if (current && current.status !== 'complete') {
        throw new Error(current.status === 'review'
          ? `Issue ${current.id} is awaiting developer review in Valence. Approve it to continue the task.`
          : `Issue ${current.id} is not complete. The agent must unblock and complete it through vl.`)
      }
      const complete = state.issueIds.every((id) => tracker.get(id).status === 'complete')
      this.store.saveTaskExecution({ ...state, currentIssueId: null, phase: complete ? 'complete' : 'working', error: null })
    })
    this.ownedClaims.delete(taskId)
  }

  stop(taskId: string, error: string): void {
    const state = this.store.getTaskExecution(taskId)
    if (!state || state.phase === 'complete') return
    try {
      // Only a claim recorded for this running Anvil turn can be released here.
      if (state.currentIssueId && this.ownedClaims.get(taskId) === state.currentIssueId) this.withTracker(state, (tracker) => {
        if (tracker.get(state.currentIssueId!).status === 'working') tracker.block(state.currentIssueId!)
      })
    } catch (storageError) {
      error += ` Could not block the Valence issue: ${storageError instanceof Error ? storageError.message : String(storageError)}`
    }
    this.ownedClaims.delete(taskId)
    this.store.saveTaskExecution({ ...state, phase: 'blocked', error })
  }

  private requireState(taskId: string): TaskExecutionState {
    const state = this.store.getTaskExecution(taskId)
    if (!state) throw new Error('Task execution not found')
    return state
  }

  /** The worktree commit at submit time anchors the per-issue review diff. */
  private recordReviewCommit(tracker: IssueTracker, issue: Issue, headCommit: string | undefined): void {
    if (headCommit && (issue.status === 'review' || issue.status === 'complete') && issue.headCommit !== headCommit) {
      tracker.recordCommits(issue.id, { headCommit })
    }
  }

  private withTracker<Result>(state: TaskExecutionState, operation: (tracker: IssueTracker) => Result): Result {
    return this.store.transaction(() => {
      const task = this.store.getTask(state.taskId)
      if (!task) throw new Error('Task not found')
      const project = this.store.getProjects().find((entry) => entry.id === task.projectId)
      if (project?.path !== state.projectPath) throw new Error('Task project does not match execution project')
      const tracker = this.store.issueTracker(task.projectId)
      try {
        if (tracker.getParent(state.parentIssueId).anvilTaskId !== task.id) {
          throw new Error('Parent issue belongs to another task')
        }
        if (state.issueIds.some((id) => tracker.get(id).parentId !== state.parentIssueId) ||
          (state.currentIssueId && !state.issueIds.includes(state.currentIssueId))) {
          throw new Error('Execution issue does not belong to the task plan')
        }
        return operation(tracker)
      } finally {
        tracker.close()
      }
    })
  }
}
