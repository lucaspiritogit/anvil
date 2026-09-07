import type { CodexSandboxPolicy } from './codex-app-server-protocol'

/** Browser validation needs unrestricted execution, including macOS Mach IPC. */
export function codexSandboxPolicy(): CodexSandboxPolicy {
  return { type: 'dangerFullAccess' }
}
