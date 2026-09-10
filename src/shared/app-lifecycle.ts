/** Main-to-renderer signals that gate the startup shell. */
export const APP_READY_CHANNEL = 'app:ready'
export const APP_INIT_FAILED_CHANNEL = 'app:init-failed'

/** Result of main-process service initialization. */
export type AppReadiness = { ok: true } | { ok: false; message: string }
