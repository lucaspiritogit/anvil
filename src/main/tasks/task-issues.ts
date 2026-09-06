import {
  initializeTracker, openTracker, TrackerNotInitializedError,
  type BatchIssue, type Completion, type Issue, type IssueTracker
} from 'valence'
import type { TaskExecutionState } from '../../shared/types'
import type { Store } from '../store'

/** Associates Anvil tasks with Valence IDs. Never writes or copies issue records. */
export class TaskIssues {
  private readonly ownedClaims = new Map<string, string>()

  constructor(private readonly store: Store) {}

  initialize(taskId: string, projectPath: string): TaskExecutionState {
    // Starting a new task authorizes first-time setup, not upgrades of existing storage.
    let tracker: IssueTracker
    try {
      tracker = openTracker(projectPath)
    } catch (error) {
      if (!(error instanceof TrackerNotInitializedError)) throw error
      tracker = initializeTracker(projectPath)
    }
    tracker.close()
    return this.store.saveTaskExecution({
      taskId, projectPath, phase: 'planning', issueIds: [], currentIssueId: null,
      error: null, eventOffset: 0
    })
  }

  plan(taskId: string, inputs: BatchIssue[]): void {
    const state = this.requireState(taskId)
    if (state.phase !== 'planning' || state.issueIds.length) throw new Error('This task already has a plan')
    // The issue limit is an Anvil product policy, not a Valence limit.
    if (!Array.isArray(inputs) || inputs.length > 50) throw new Error('The plan must contain at most 50 issues')
    // The output parser accepts an empty plan only with an explicit noChanges response.
    if (!inputs.length) {
      this.store.saveTaskExecution({ ...state, phase: 'complete' })
      return
    }
    this.withTracker(state, (tracker) => {
      const issues = tracker.createMany(inputs)
      this.store.saveTaskExecution({ ...state, phase: 'working', issueIds: issues.map((issue) => issue.id) })
    })
  }

  claim(taskId: string): Issue | undefined {
    const state = this.requireState(taskId)
    if (state.phase !== 'working' || state.currentIssueId) throw new Error('Task is not ready to claim work')
    return this.withTracker(state, (tracker) => {
      const issue = tracker.claim({ ids: state.issueIds })
      if (issue) {
        this.ownedClaims.set(taskId, issue.id)
        this.store.saveTaskExecution({ ...state, currentIssueId: issue.id })
      }
      return issue
    })
  }

  list(taskId: string): Issue[] {
    const state = this.requireState(taskId)
    return this.withTracker(state, (tracker) => state.issueIds.map((id) => tracker.get(id)))
  }

  complete(taskId: string, completion: Completion): void {
    const state = this.requireState(taskId)
    if (!state.currentIssueId) throw new Error('No issue is currently running')
    this.withTracker(state, (tracker) => {
      tracker.complete(state.currentIssueId!, completion)
      this.ownedClaims.delete(taskId)
      const complete = state.issueIds.every((id) => tracker.get(id).status === 'complete')
      this.store.saveTaskExecution({ ...state, currentIssueId: null, phase: complete ? 'complete' : 'working', error: null })
    })
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

  private withTracker<Result>(state: TaskExecutionState, operation: (tracker: IssueTracker) => Result): Result {
    const tracker = openTracker(state.projectPath)
    try {
      return operation(tracker)
    } finally {
      tracker.close()
    }
  }
}
