import type { DatabaseSync } from 'node:sqlite'

let savepointSequence = 0

/** Run synchronous work under an immediate transaction, nesting with savepoints. */
export function sqliteTransaction<Result>(
  database: DatabaseSync,
  operation: () => Result,
  behavior: 'deferred' | 'immediate' = 'deferred'
): Result {
  if (database.isTransaction) {
    const savepoint = `anvil_${++savepointSequence}`
    database.exec(`SAVEPOINT ${savepoint}`)
    try {
      const result = operation()
      database.exec(`RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      try {
        database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        database.exec(`RELEASE SAVEPOINT ${savepoint}`)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Could not roll back nested SQLite transaction')
      }
      throw error
    }
  }

  database.exec(behavior === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      if (database.isTransaction) database.exec('ROLLBACK')
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Could not roll back SQLite transaction')
    }
    throw error
  }
}
