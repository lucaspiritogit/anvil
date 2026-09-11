import { expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { registerAppShutdown } from '../src/client/main/app-shutdown'
import { onTestCleanup } from './test-cleanup'

class TestApplication extends EventEmitter {
  exit = vi.fn()
  quit(): void {
    this.emit('before-quit', { preventDefault: vi.fn() })
  }
}

function setup(cleanup: Array<() => void | Promise<void>>, showClosing = vi.fn()) {
  vi.useFakeTimers()
  onTestCleanup(() => { vi.useRealTimers() })
  const application = new TestApplication()
  onTestCleanup(() => { application.removeAllListeners() })
  const finalize = vi.fn()
  const reportError = vi.fn()
  const isClosing = registerAppShutdown(application, { cleanup, showClosing, finalize, reportError, timeoutMs: 100 })
  return { application, finalize, reportError, isClosing, showClosing }
}

test('repeated Cmd+Q waits for cleanup once and exits without a second cancellable quit', async () => {
  let finish!: () => void
  const cleanup = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  const { application, finalize, isClosing, showClosing } = setup([cleanup])
  expect(isClosing()).toBe(false)
  application.quit()
  application.quit()
  expect(isClosing()).toBe(true)
  expect(application.exit).not.toHaveBeenCalled()
  expect(cleanup).toHaveBeenCalledOnce()
  expect(showClosing).toHaveBeenCalledOnce()
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(finalize).toHaveBeenCalledOnce()
  expect(application.exit).toHaveBeenCalledExactlyOnceWith(0)
  expect(isClosing(), 'Do not reopen windows while exiting').toBe(true)
  await vi.advanceTimersByTimeAsync(100)
  expect(application.exit).toHaveBeenCalledOnce()
})

test('cleanup errors do not skip other services or trap quit', async () => {
  let finish!: () => void
  const error = new Error('Cleanup failed')
  const peer = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  const { application, reportError } = setup([() => { throw error }, async () => { throw error }, peer])
  application.quit()
  await vi.advanceTimersByTimeAsync(0)
  expect(peer).toHaveBeenCalledOnce()
  expect(application.exit).not.toHaveBeenCalled()
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(reportError).toHaveBeenCalledTimes(2)
  expect(application.exit).toHaveBeenCalledExactlyOnceWith(1)
})

test('a hung service has a deadline and late completion cannot exit twice', async () => {
  let finish!: () => void
  const { application, reportError, finalize } = setup([() => new Promise<void>((resolve) => { finish = resolve })])
  application.quit()
  await vi.advanceTimersByTimeAsync(99)
  expect(application.exit).not.toHaveBeenCalled()
  application.quit()
  await vi.advanceTimersByTimeAsync(1)
  expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'App cleanup timed out' }))
  expect(finalize).toHaveBeenCalledOnce()
  expect(application.exit).toHaveBeenCalledExactlyOnceWith(1)
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(application.exit).toHaveBeenCalledOnce()
})

test('closing UI, finalization and logging errors cannot block exit', async () => {
  const cleanup = vi.fn()
  const { application, finalize, reportError } = setup([cleanup], vi.fn(() => { throw new Error('Window failed') }))
  finalize.mockImplementation(() => { throw new Error('Database failed') })
  reportError.mockImplementation(() => { throw new Error('Logger failed') })
  application.quit()
  await vi.advanceTimersByTimeAsync(0)
  expect(cleanup).toHaveBeenCalledOnce()
  expect(application.exit).toHaveBeenCalledExactlyOnceWith(1)
})
