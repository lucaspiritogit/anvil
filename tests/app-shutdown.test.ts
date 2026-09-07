import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { registerAppShutdown } from '../src/main/app-shutdown'

class TestApplication extends EventEmitter {
  exited = false
  quit(): void {
    let prevented = false
    this.emit('before-quit', { preventDefault: () => { prevented = true } })
    if (!prevented) this.exited = true
  }
}

async function main(): Promise<void> {
  const application = new TestApplication()
  let finishCleanup!: () => void
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve })
  let cleanupCalls = 0
  let loaderCalls = 0
  const isClosing = registerAppShutdown(application, {
    showClosing: () => { loaderCalls++ },
    cleanup: () => { cleanupCalls++; return cleanup },
    reportError: (error) => { throw error }
  })
  assert.equal(isClosing(), false)
  application.quit()
  application.quit()
  assert.equal(isClosing(), true)
  assert.equal(application.exited, false, 'Cmd+Q must wait for owned processes')
  assert.equal(loaderCalls, 1)
  assert.equal(cleanupCalls, 1, 'Repeated quit requests must share cleanup')
  finishCleanup()
  await setImmediate()
  assert.equal(application.exited, true)
  assert.equal(isClosing(), false, 'Window close must be allowed after cleanup')

  const failed = new TestApplication()
  const errors: unknown[] = []
  registerAppShutdown(failed, {
    showClosing: () => {},
    cleanup: async () => { throw new Error('Cleanup failed') },
    reportError: (error) => { errors.push(error) }
  })
  failed.quit()
  await setImmediate()
  assert.equal(failed.exited, false, 'Do not exit before cleanup succeeds')
  assert.equal(errors.length, 1)
  console.log('App shutdown tests passed: quit interception, loader, repeated requests, awaited cleanup, and failure handling.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
