import { APP_INIT_FAILED_CHANNEL, APP_READY_CHANNEL, type AppReadiness } from '../shared/app-lifecycle'

/** The smallest window surface needed to deliver startup readiness. */
export interface ReadinessTarget {
  isDestroyed(): boolean
  webContents: {
    isLoadingMainFrame(): boolean
    once(event: 'did-finish-load', listener: () => void): unknown
    send(channel: string, payload?: unknown): void
  }
}

/** Serializes an unknown initialization failure into a readiness payload. */
export function initFailureReadiness(error: unknown): AppReadiness {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

/**
 * Delivers a startup signal to the renderer. While the main frame is still
 * loading the send is queued on did-finish-load so the event cannot race the
 * renderer's first paint or its subscription to the readiness latch.
 */
export function notifyRendererReady(target: ReadinessTarget | null, channel: string, payload: AppReadiness): void {
  if (!target || target.isDestroyed()) return
  if (target.webContents.isLoadingMainFrame()) {
    target.webContents.once('did-finish-load', () => {
      if (!target.isDestroyed()) target.webContents.send(channel, payload)
    })
    return
  }
  target.webContents.send(channel, payload)
}

export interface StartApplicationOptions<T> {
  /** Creates and loads the main window before any service work starts. */
  createWindow(): void
  /** Constructs the main-process services. */
  initializeServices(): Promise<T>
  /** Returns the window that receives the readiness signal. */
  getWindow(): ReadinessTarget | null
  /** Registers shutdown, menu, focus, and other listeners for resolved services. */
  onServicesReady(services: T): void
  /** Logs and surfaces an initialization failure. */
  onInitFailed(error: unknown): void
}

/**
 * Window-first application startup. The window is created and can paint its
 * shell before `initializeServices` runs; readiness is sent only after the
 * services resolve, and any failure is surfaced instead of leaving the shell
 * waiting forever.
 */
export async function startApplication<T>(options: StartApplicationOptions<T>): Promise<T | undefined> {
  try {
    options.createWindow()
    const services = await options.initializeServices()
    options.onServicesReady(services)
    notifyRendererReady(options.getWindow(), APP_READY_CHANNEL, { ok: true })
    return services
  } catch (error) {
    try {
      options.onInitFailed(error)
    } catch (reportError) {
      console.error('Could not report startup failure:', reportError)
    }
    notifyRendererReady(options.getWindow(), APP_INIT_FAILED_CHANNEL, initFailureReadiness(error))
    return undefined
  }
}
