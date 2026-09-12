interface QuitEvent {
  preventDefault(): void
}

interface QuitApplication {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown
  exit(code: number): void
}

interface ShutdownOptions {
  showClosing(): void
  cleanup: Array<() => void | Promise<void>>
  finalize(): void
  reportError(error: unknown): void
  timeoutMs?: number
}

export function registerAppShutdown(application: QuitApplication, options: ShutdownOptions): () => boolean {
  let closing = false

  application.on('before-quit', (event) => {
    event.preventDefault()
    if (closing) {
      return
    }

    closing = true
    void shutDownApplication(application, options)
  })

  return () => closing
}

async function shutDownApplication(application: QuitApplication, options: ShutdownOptions): Promise<void> {
  let exited = false

  const finish = (exitCode: number): void => {
    if (exited) {
      return
    }

    exited = true
    clearTimeout(deadline)

    try {
      options.finalize()
    } catch (error) {
      reportShutdownError(options, error)
      exitCode = 1
    }

    application.exit(exitCode)
  }

  const deadline = setTimeout(() => {
    reportShutdownError(options, new Error('App cleanup timed out'))
    finish(1)
  }, options.timeoutMs ?? 8_000)

  try {
    options.showClosing()
  } catch (error) {
    reportShutdownError(options, error)
  }

  const results = await Promise.allSettled(options.cleanup.map(async (cleanup) => cleanup()))
  if (exited) {
    return
  }

  let exitCode = 0
  for (const result of results) {
    if (result.status === 'rejected') {
      reportShutdownError(options, result.reason)
      exitCode = 1
    }
  }

  finish(exitCode)
}

function reportShutdownError(options: ShutdownOptions, error: unknown): void {
  try {
    options.reportError(error)
  } catch {
    // Logging must not prevent exit.
  }
}
