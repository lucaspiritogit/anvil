// Register cleanup immediately after acquiring a resource, before assertions.
// Hooks drain in reverse order, including when a test fails.
const cleanups: (() => void | Promise<void>)[] = []
export function onTestCleanup(cleanup: () => void | Promise<void>): void {
  cleanups.push(cleanup)
}
export async function cleanupTestResources(): Promise<void> {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Test resource cleanup failed')
}
