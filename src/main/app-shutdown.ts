interface QuitEvent {
  preventDefault(): void
}

interface QuitApplication {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown
  quit(): void
}

/** Electron does not await before-quit handlers. Hold quit until cleanup completes. */
export function registerAppShutdown(application: QuitApplication, options: {
  showClosing(): void
  cleanup(): Promise<void>
  reportError(error: unknown): void
}): () => boolean {
  let closing = false
  let readyToQuit = false
  application.on('before-quit', (event) => {
    if (readyToQuit) return
    event.preventDefault()
    if (closing) return
    closing = true
    options.showClosing()
    void options.cleanup().then(() => {
      readyToQuit = true
      application.quit()
    }, (error: unknown) => {
      // Never exit claiming cleanup succeeded if owned processes could still exist.
      options.reportError(error)
    })
  })
  return () => closing && !readyToQuit
}
