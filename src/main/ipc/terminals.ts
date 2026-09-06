import { ipcMain } from 'electron'
import type { TerminalManager } from '../terminal'

export function registerTerminalHandlers(terminals: TerminalManager): void {
  ipcMain.handle(
    'terminal:ensure',
    (_event, input: { id: string; cwd: string; cols: number; rows: number }) => {
      terminals.create(input.id, input.cwd, input.cols, input.rows)
      return true
    }
  )

  ipcMain.on('terminal:write', (_event, input: { id: string; data: string }) => {
    terminals.write(input.id, input.data)
  })

  ipcMain.on('terminal:resize', (_event, input: { id: string; cols: number; rows: number }) => {
    terminals.resize(input.id, input.cols, input.rows)
  })
}
