import Database from 'better-sqlite3'
import { join } from 'node:path'
import { IssueTracker } from '../src/main/valence/tracker'
import { testHome } from './issue-tracker-doubles'
import type { Store } from '../src/main/store'

/** Read both clients' public interfaces without querying either database directly. */
export function taskState(store: Store, taskId: string) {
  const state = store.getTaskExecution(taskId)
  if (!state) return undefined
  const tracker = store.issueTracker(store.getTask(taskId)!.projectId)
  try {
    return { ...state, items: state.issueIds.map((id) => tracker.get(id)) }
  } finally {
    tracker.close()
  }
}

/** Agent-side connection: never constructs Store or runs startup recovery. */
export function openTaskTracker(projectPath: string, databasePath = join(testHome, '.anvil-composer/anvil.db')): IssueTracker {
  const connection = new Database(databasePath, { fileMustExist: true })
  try {
    const project = connection.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined
    if (!project) throw new Error('Project not found')
    return new IssueTracker(connection, project.id, 'owned')
  } catch (error) {
    connection.close()
    throw error
  }
}
