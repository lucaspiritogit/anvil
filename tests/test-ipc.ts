import { registerIpc } from '../src/main/ipc'
import { getRendererWindow, rendererUrl } from './renderer-fixture'
import { onTestCleanup } from './test-cleanup'

/** Register IPC with teardown for polling, agents and memory. */
export function registerTestIpc(): ReturnType<typeof registerIpc> {
  const runtime = registerIpc(getRendererWindow, rendererUrl)
  onTestCleanup(async () => {
    // Task startup queues an immediate after returning its IPC result. Drain it
    // before closing agents or SQLite, including after a failed assertion.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const results = await Promise.allSettled([
      Promise.resolve().then(() => runtime.stopCaffeineMode()),
      Promise.resolve().then(() => runtime.terminals.disposeAll()),
      Promise.resolve().then(() => runtime.githubPolling.close()),
      Promise.resolve().then(() => runtime.agentProcesses.close()),
      Promise.resolve().then(() => runtime.projectMemory?.close())
    ])
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    if (errors.length) throw new AggregateError(errors, 'IPC fixture cleanup failed')
  })
  return runtime
}
