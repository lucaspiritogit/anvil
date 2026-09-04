import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentDefinition, Project, Run, RunDiff, RunEvent, Settings } from '../shared/types'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch)
  },
  agents: {
    list: (): Promise<AgentDefinition[]> => ipcRenderer.invoke('agents:list')
  },
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    add: (): Promise<Project | null> => ipcRenderer.invoke('projects:add'),
    update: (input: {
      id: string
      monthlyTokenLimit: number | null
      monthlyCostLimitUsd: number | null
      finishOnPush: boolean
    }): Promise<Project | undefined> => ipcRenderer.invoke('projects:update', input),
    remove: (id: string): Promise<Project[]> => ipcRenderer.invoke('projects:remove', id),
    reveal: (path: string): Promise<string> => ipcRenderer.invoke('projects:reveal', path)
  },
  runs: {
    list: (): Promise<Run[]> => ipcRenderer.invoke('runs:list'),
    events: (runId: string): Promise<RunEvent[]> => ipcRenderer.invoke('runs:events', runId),
    diff: (runId: string): Promise<RunDiff> => ipcRenderer.invoke('runs:diff', runId),
    start: (input: {
      projectId: string
      agentId: string
      prompt: string
      model?: string
    }): Promise<Run> => ipcRenderer.invoke('runs:start', input),
    cancel: (runId: string): Promise<boolean> => ipcRenderer.invoke('runs:cancel', runId),
    onEvent: (handler: (event: RunEvent) => void): (() => void) =>
      subscribe<RunEvent>('run:event', handler),
    onUpdated: (handler: (run: Run) => void): (() => void) => subscribe<Run>('run:updated', handler)
  },
  terminal: {
    ensure: (input: { id: string; cwd: string; cols: number; rows: number }): Promise<boolean> =>
      ipcRenderer.invoke('terminal:ensure', input),
    write: (id: string, data: string): void => ipcRenderer.send('terminal:write', { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('terminal:resize', { id, cols, rows }),
    onData: (handler: (payload: { id: string; data: string }) => void): (() => void) =>
      subscribe('terminal:data', handler),
    onExit: (handler: (payload: { id: string; code: number }) => void): (() => void) =>
      subscribe('terminal:exit', handler)
  }
}

contextBridge.exposeInMainWorld('anvil', api)

export type AnvilApi = typeof api
