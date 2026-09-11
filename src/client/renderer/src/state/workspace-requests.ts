// Preference writes and selections share ordering across mounted views.
// Callers capture identity before enqueueing, never when the operation runs.
let pending: Promise<unknown> = Promise.resolve()
export function enqueueWorkspaceRequest<T>(operation: () => Promise<T>): Promise<T> {
  const next = pending.then(operation)
  pending = next.catch(() => {})
  return next
}
