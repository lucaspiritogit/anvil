import { join, resolve } from 'node:path'
import { createAnvilRuntime } from '../src/server/runtime'
import { handlers, testHome } from './issue-tracker-doubles'
import { rendererContents } from './renderer-fixture'
import { onTestCleanup } from './test-cleanup'

/** Existing domain suites call the in-process runtime, with no Electron transport. */
export function registerTestIpc(): ReturnType<typeof createAnvilRuntime> {
  const runtime = createAnvilRuntime({
    dataDirectory: process.env.ANVIL_DATA_DIR ?? join(testHome, '.anvil-composer'),
    migrationsDirectory: resolve('src/server/db/migrations'),
    memoryMigrationsDirectory: resolve('src/server/memory/migrations')
  })
  for (const channel of runtime.channels()) {
    handlers.set(channel, (_event, input) => runtime.invoke(channel, input))
  }
  const unsubscribe = runtime.subscribeAll((channel, payload) => rendererContents.send(channel, payload))
  onTestCleanup(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    unsubscribe()
    await runtime.close()
  })
  return runtime
}
