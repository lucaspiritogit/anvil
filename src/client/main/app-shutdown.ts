interface QuitEvent {
  preventDefault(): void
}

interface QuitApplication {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown
  exit(code: number): void
}

/** Run every cleanup once, then exit even if a service or window refuses to close. */
export function registerAppShutdown(application: QuitApplication, options: {
  showClosing(): void
  cleanup: Array<() => void | Promise<void>>
  finalize(): void
  reportError(error: unknown): void
  timeoutMs?: number
}): () => boolean {
  let closing = false
  let exited = false
  const report = (error: unknown): void => {
    try { options.reportError(error) } catch { /* Logging must not prevent exit. */ }
  }
  application.on('before-quit', (event) => {
    event.preventDefault()
    if (closing) return
    closing = true
    const finish = (code: number): void => {
      if (exited) return
      exited = true
      clearTimeout(deadline)
      try { options.finalize() } catch (error) { report(error); code = 1 }
      // app.quit() can be cancelled again by window close/beforeunload listeners.
      application.exit(code)
    }
    const deadline = setTimeout(() => {
      report(new Error('App cleanup timed out'))
      finish(1)
    }, options.timeoutMs ?? 8_000)
    try { options.showClosing() } catch (error) { report(error) }
    // Wrap each call so one synchronous exception cannot skip the other services.
    void Promise.allSettled(options.cleanup.map(async (cleanup) => cleanup())).then((results) => {
      if (exited) return
      const failures = results.filter((result) => result.status === 'rejected')
      for (const result of failures) report(result.reason)
      finish(failures.length ? 1 : 0)
    })
  })
  return () => closing
}
