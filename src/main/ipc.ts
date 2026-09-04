import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { BUILTIN_AGENTS, getAgent } from './agents/registry'
import { AgentRunner, type ExitInfo, type UsageInfo } from './agents/runner'
import { Store } from './store'
import { TerminalManager } from './terminal'
import { GitDeliveryManager } from './git-delivery'
import type {
  Project,
  Run,
  RunDiff,
  RunEvent,
  RunEventKind,
  Settings
} from '../shared/types'

function titleFor(prompt: string): string {
  const line = prompt.trim().split('\n')[0].trim()
  return line.length > 72 ? `${line.slice(0, 71)}...` : line || 'Untitled task'
}

export function registerIpc(getWindow: () => BrowserWindow | null): {
  runner: AgentRunner
  terminals: TerminalManager
} {
  const store = new Store(join(app.getPath('home'), '.anvil-composer', 'anvil.db'))
  const runner = new AgentRunner()
  const gitDelivery = new GitDeliveryManager(
    join(app.getPath('home'), '.anvil-composer', 'worktrees')
  )

  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }

  const terminals = new TerminalManager({
    onData: (id, data) => send('terminal:data', { id, data }),
    onExit: (id, code) => send('terminal:exit', { id, code })
  })

  runner.on('event', (event: RunEvent) => {
    store.appendEvent(event)
    send('run:event', event)
  })

  const recordSystemEvent = (
    runId: string,
    text: string,
    kind: RunEventKind = 'delivery'
  ): void => {
    const event: RunEvent = {
      id: randomUUID(),
      runId,
      ts: Date.now(),
      stream: 'system',
      kind,
      text
    }
    store.appendEvent(event)
    send('run:event', event)
  }

  const finishRun = async (info: ExitInfo): Promise<void> => {
    const status = info.cancelled ? 'cancelled' : info.code === 0 ? 'succeeded' : 'failed'
    let run = store.updateRun(info.runId, {
      status,
      endedAt: Date.now(),
      exitCode: info.code,
      error: info.error,
      deliveryStatus: 'finalizing'
    })
    if (run) send('run:updated', run)
    if (!run?.worktreePath || !run.baseCommit) return
    const project = store.getProjects().find((item) => item.id === run?.projectId)
    if (!project) return

    recordSystemEvent(run.id, 'Saving the task branch for delivery.')
    try {
      const successful = status === 'succeeded'
      const delivery = await gitDelivery.finalize(
        project.path,
        run.worktreePath,
        run.baseCommit,
        run.title,
        successful
          ? () => {
              const pending = store.updateRun(info.runId, {
                deliveryStatus: 'did_not_commit'
              })
              if (pending) send('run:updated', pending)
              recordSystemEvent(
                info.runId,
                'did_not_commit: the agent left uncommitted changes. The Anvil finisher is committing them.',
                'did_not_commit'
              )
            }
          : undefined
      )
      run = store.updateRun(run.id, {
        deliveryStatus: successful
          ? delivery.hasChanges
            ? 'reviewable'
            : 'no_changes'
          : 'agent_failed',
        headCommit: delivery.headCommit,
        filesChanged: delivery.filesChanged,
        additions: delivery.additions,
        deletions: delivery.deletions,
        ...(successful ? {} : { deliveryError: 'The agent did not exit successfully.' })
      })
      if (delivery.cleanupWarning) {
        recordSystemEvent(run?.id ?? info.runId, `Worktree cleanup warning: ${delivery.cleanupWarning}`)
      }
      if (run) {
        recordSystemEvent(
          run.id,
          run.deliveryStatus === 'reviewable'
            ? `Code is reviewable on local branch ${run.branchName}.`
            : run.deliveryStatus === 'no_changes'
              ? 'Task succeeded without code changes.'
              : `Agent work was retained on local branch ${run.branchName}, but is not ready for review.`
        )
        send('run:updated', run)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      run = store.updateRun(info.runId, { deliveryStatus: 'failed', deliveryError: message })
      recordSystemEvent(info.runId, `Git delivery failed: ${message}`)
      if (run) send('run:updated', run)
    }
  }

  runner.on('exit', (info: ExitInfo) => {
    void finishRun(info)
  })

  runner.on('usage', (info: UsageInfo) => {
    const { runId, ...usage } = info
    const run = store.updateRun(runId, usage)
    if (run) send('run:updated', run)
  })

  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => store.setSettings(patch))

  ipcMain.handle('agents:list', () => BUILTIN_AGENTS)

  ipcMain.handle('projects:list', () => store.getProjects())

  ipcMain.handle('projects:add', async () => {
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    if (result.canceled || !result.filePaths.length) return null

    const path = result.filePaths[0]
    const project: Project = {
      id: randomUUID(),
      name: basename(path) || path,
      path,
      createdAt: Date.now(),
      monthlyTokenLimit: null,
      monthlyCostLimitUsd: null,
      finishOnPush: false,
      gitPlatform: 'github'
    }
    return store.addProject(project)
  })

  ipcMain.handle('projects:remove', (_e, id: string) => {
    terminals.dispose(id)
    store.removeProject(id)
    return store.getProjects()
  })

  ipcMain.handle(
    'projects:update',
    (
      _e,
      input: {
        id: string
        monthlyTokenLimit: number | null
        monthlyCostLimitUsd: number | null
        finishOnPush: boolean
      }
    ) => store.updateProject(input.id, input)
  )

  ipcMain.handle('projects:reveal', (_e, path: string) => shell.openPath(path))

  ipcMain.handle('runs:list', () => store.getRuns())
  ipcMain.handle('runs:events', (_e, runId: string) => store.readEvents(runId))
  ipcMain.handle('runs:diff', async (_e, runId: string): Promise<RunDiff> => {
    const run = store.getRun(runId)
    if (!run?.baseCommit || !run.headCommit) throw new Error('This task has no delivered code')
    const project = store.getProjects().find((item) => item.id === run.projectId)
    if (!project) throw new Error('Project not found')
    return gitDelivery.getDiff(project.path, run.baseCommit, run.headCommit)
  })

  ipcMain.handle(
    'runs:start',
    async (_e, input: { projectId: string; agentId: string; prompt: string; model?: string }) => {
      const project = store.getProjects().find((p) => p.id === input.projectId)
      if (!project) throw new Error('Project not found')

      const agent = getAgent(input.agentId)
      if (!agent) throw new Error(`Unknown agent: ${input.agentId}`)

      const model = input.model || agent.defaultModel

      const run: Run = {
        id: randomUUID(),
        projectId: project.id,
        agentId: agent.id,
        agentLabel: agent.label,
        model,
        prompt: input.prompt,
        title: titleFor(input.prompt),
        cwd: project.path,
        status: 'running',
        startedAt: Date.now(),
        exitCode: null,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        costUsd: null,
        deliveryStatus: 'preparing',
        filesChanged: 0,
        additions: 0,
        deletions: 0
      }
      store.addRun(run)

      try {
        const prepared = await gitDelivery.prepare(project.path, run.id, run.title)
        const preparedRun = store.updateRun(run.id, {
          cwd: prepared.cwd,
          deliveryStatus: 'working',
          baseBranch: prepared.baseBranch,
          branchName: prepared.branchName,
          baseCommit: prepared.baseCommit,
          worktreePath: prepared.worktreePath
        })!
        if (prepared.initializedRepository) {
          recordSystemEvent(
            run.id,
            'Anvil created the repository initial commit before starting this task.'
          )
        }
        const executionPrompt = [
          `You are working in an Anvil-managed Git worktree on branch ${prepared.branchName}.`,
          'Complete the task independently and run the relevant checks.',
          'You do not need to commit or push. Anvil handles uncommitted changes and Git delivery after you exit.',
          'Do not switch branches or rewrite existing history.',
          '',
          input.prompt
        ].join('\n')
        setImmediate(() => {
          runner.start({
            runId: run.id,
            agent,
            prompt: executionPrompt,
            model,
            cwd: prepared.cwd
          })
        })
        return preparedRun
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failed = store.updateRun(run.id, {
          status: 'failed',
          endedAt: Date.now(),
          exitCode: null,
          error: message,
          deliveryStatus: 'failed',
          deliveryError: message
        })!
        recordSystemEvent(run.id, `Could not prepare Git workspace: ${message}`)
        return failed
      }
    }
  )

  ipcMain.handle('runs:cancel', (_e, runId: string) => runner.cancel(runId))

  ipcMain.handle(
    'terminal:ensure',
    (_e, input: { id: string; cwd: string; cols: number; rows: number }) => {
      terminals.create(input.id, input.cwd, input.cols, input.rows)
      return true
    }
  )

  ipcMain.on('terminal:write', (_e, input: { id: string; data: string }) => {
    terminals.write(input.id, input.data)
  })

  ipcMain.on('terminal:resize', (_e, input: { id: string; cols: number; rows: number }) => {
    terminals.resize(input.id, input.cols, input.rows)
  })

  return { runner, terminals }
}
