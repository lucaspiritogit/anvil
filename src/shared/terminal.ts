export interface TerminalOutput {
  sessionId: string
  sequence: number
  data: string
}

export interface TerminalExit {
  sessionId: string
  exitCode: number
}

export interface TerminalSnapshot {
  data: string
  sequence: number
  exitCode?: number
}
