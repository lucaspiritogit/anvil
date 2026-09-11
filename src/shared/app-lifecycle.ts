/** Connection readiness gates initial loading and refreshes state after reconnecting. */
export type AppReadiness = { ok: true } | { ok: false; message: string }
