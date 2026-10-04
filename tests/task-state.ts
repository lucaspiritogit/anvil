import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { IssueTracker } from '../apps/server/src/anvil-issue-tracker/tracker'
import { testHome } from './issue-tracker-doubles'
import type { Store } from '../apps/server/src/store'

/** Read both clients' public interfaces without querying either database directly. */
export function taskState(store: Store, taskId: string) {
  const state = store.getTaskExecution(taskId)
  const task = store.getTask(taskId)
  if (!state || !task?.projectId) return undefined
  const tracker = store.issueTracker(task.projectId, task.workspaceId)
  try {
    return { ...state, items: state.issueIds.map((id) => tracker.get(id)) }
  } finally {
    tracker.close()
  }
}

/** Independent test connection: never constructs Store or runs startup recovery. */
export function openTaskTracker(projectPath: string, databasePath = join(testHome, '.anvil-composer/workspaces/Default/anvil.db')): IssueTracker {
  const connection = new DatabaseSync(databasePath)
  try {
    const project = connection.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined
    if (!project) throw new Error('Project not found')
    return new IssueTracker(connection, project.id, 'owned')
  } catch (error) {
    connection.close()
    throw error
  }
}
