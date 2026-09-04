import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { BUILTIN_AGENTS, GIT_SYSTEM_PROMPT, getAgent } from './agents/registry'
import {
  AgentRunner,
  type ExitInfo,
  type SessionInfo,
  type UsageInfo
} from './agents/runner'
import { Store } from './store'
import { TerminalManager } from './terminal'
import { GitDeliveryManager } from './git-delivery'
import type {
  Project,
  RebaseStep,
  Run,
  RunComment,
  RunDiff,
  RunEvent,
  RunEventCategory,
  RunEventKind,
  Settings
} from '../shared/types'

/**
 * The agent-mode rebase task. Scoped to the commits this task added: everything up to and
 * including `baseCommit` is history that predates the task and is left alone.
 * `reset --soft` keeps every change staged, so nothing can be lost by it.
 */
function agentRebasePrompt(baseCommit: string): string {
  return [
    `Rebase the commits on this branch into a single commit on top of ${baseCommit}.`,
    '',
    `Run \`git reset --soft ${baseCommit}\` and then commit the staged changes once.`,
    'Write the commit message yourself, covering the whole of the work.',
    `Do not alter, drop or reorder anything at or before ${baseCommit}, do not discard`,
    'changes, and do not rebase, amend earlier history, or push.',
    'Change no files: this is only a history operation.'
  ].join('\n')
}

/** Renders the developer's review notes as the follow-up task for the agent. */
function reviewPrompt(comments: RunComment[]): string {
  const notes = comments
    .map((comment) => `${comment.file}:${comment.lineNumber} — ${comment.body}`)
    .join('\n')
  return [
    'The developer reviewed your changes and left the notes below.',
    'Address each one in the code, then commit.',
    '',
    notes
  ].join('\n')
}

function titleFor(prompt: string): string {
  const line = prompt.trim().split('\n')[0].trim()
  return line.length > 72 ? `${line.slice(0, 71)}...` : line || 'Untitled task'
}

export function registerIpc(getWindow: () => BrowserWindow | null): {
  runner: AgentRunner
  terminals: TerminalManager
} {
  // Migrations ship as files, so they are resolved from the app root: the
  // project directory in development, the packaged bundle in a build (see the
  // `files` list in electron-builder.yml).
  const store = new Store(join(app.getPath('home'), '.anvil-composer', 'anvil.db'), {
    migrationsFolder: join(app.getAppPath(), 'src', 'main', 'db', 'migrations')
  })
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
    kind: RunEventKind = 'delivery',
    category: RunEventCategory = 'system'
  ): void => {
    const event: RunEvent = {
      id: randomUUID(),
      runId,
      ts: Date.now(),
      stream: 'system',
      kind,
      category,
      text
    }
    store.appendEvent(event)
    send('run:event', event)
  }

  const finishRun = async (info: ExitInfo): Promise<void> => {
    const status = info.cancelled ? 'cancelled' : info.code === 0 ? 'succeeded' : 'failed'
    // Runs in a project without Git have no worktree to finalize; they keep the
    // 'unavailable' delivery status they started with.
    const existing = store.getRun(info.runId)
    const managed = Boolean(existing?.worktreePath && existing.baseCommit)
    let run = store.updateRun(info.runId, {
      status,
      endedAt: Date.now(),
      exitCode: info.code,
      error: info.error,
      ...(managed ? { deliveryStatus: 'finalizing' as const } : {})
    })
    if (run) send('run:updated', run)
    if (!managed || !run?.worktreePath || !run.baseCommit) return
    const project = store.getProjects().find((item) => item.id === run?.projectId)
    if (!project) return

    try {
      const successful = status === 'succeeded'
      let markedDidNotCommit = false
      const delivery = await gitDelivery.finalize(
        project.path,
        run.worktreePath,
        run.baseCommit,
        run.title,
        {
          onFinisherCommand: successful
            ? (command: string) => {
                if (!markedDidNotCommit) {
                  markedDidNotCommit = true
                  const pending = store.updateRun(info.runId, {
                    deliveryStatus: 'did_not_commit'
                  })
                  if (pending) send('run:updated', pending)
                }
                recordSystemEvent(info.runId, command, 'did_not_commit')
              }
            : undefined
        }
      )
      run = store.updateRun(run.id, {
        deliveryStatus: successful
          ? delivery.hasChanges
            ? 'reviewable'
            : 'no_changes'
          : 'agent_failed',
        headCommit: delivery.headCommit,
        ...(delivery.branchName ? { branchName: delivery.branchName } : {}),
        filesChanged: delivery.filesChanged,
        additions: delivery.additions,
        deletions: delivery.deletions,
        ...(successful ? {} : { deliveryError: 'The agent did not exit successfully.' })
      })
      if (delivery.cleanupWarning) {
        recordSystemEvent(run?.id ?? info.runId, `Worktree cleanup warning: ${delivery.cleanupWarning}`)
      }
      if (run) {
        if (run.deliveryStatus === 'no_changes') {
          recordSystemEvent(run.id, 'Task succeeded without code changes.')
        } else if (run.deliveryStatus !== 'reviewable') {
          recordSystemEvent(
            run.id,
            `Agent work was retained on local branch ${run.branchName}, but is not ready for review.`
          )
        }
        send('run:updated', run)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      run = store.updateRun(info.runId, { deliveryStatus: 'failed', deliveryError: message })
      recordSystemEvent(info.runId, `Git delivery failed: ${message}`, 'delivery', 'error')
      if (run) send('run:updated', run)
    }
  }

  runner.on('exit', (info: ExitInfo) => {
    void finishRun(info)
  })

  runner.on('session', (info: SessionInfo) => {
    const run = store.getRun(info.runId)
    if (!run || run.sessionId === info.sessionId) return
    const updated = store.updateRun(info.runId, { sessionId: info.sessionId })
    if (updated) send('run:updated', updated)
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

  ipcMain.handle('projects:git-status', async (_e, id: string) => {
    const project = store.getProjects().find((item) => item.id === id)
    if (!project) throw new Error('Project not found')
    return gitDelivery.status(project.path)
  })

  ipcMain.handle('projects:git-init', async (_e, id: string) => {
    const project = store.getProjects().find((item) => item.id === id)
    if (!project) throw new Error('Project not found')
    return gitDelivery.init(project.path)
  })

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

      // Without a repository there is no branch, worktree or diff to produce.
      // The agent still runs, directly in the project folder.
      const git = await gitDelivery.status(project.path)
      if (!git.isRepository) {
        const unmanagedRun = store.updateRun(run.id, {
          cwd: project.path,
          deliveryStatus: 'unavailable'
        })!
        recordSystemEvent(
          run.id,
          git.gitAvailable
            ? 'This project is not a Git repository. Anvil is running the agent directly in the project folder, without a branch or worktree.'
            : 'Git is not available on this machine. Anvil is running the agent directly in the project folder, without a branch or worktree.'
        )
        setImmediate(() => {
          runner.start({
            runId: run.id,
            agent,
            prompt: input.prompt,
            model,
            cwd: project.path
          })
        })
        return unmanagedRun
      }

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
        setImmediate(() => {
          runner.start({
            runId: run.id,
            agent,
            prompt: `${GIT_SYSTEM_PROMPT}\n\n${input.prompt}`,
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
        recordSystemEvent(run.id, `Could not prepare Git workspace: ${message}`, 'delivery', 'error')
        return failed
      }
    }
  )

  ipcMain.handle('runs:cancel', (_e, runId: string) => runner.cancel(runId))

  /** Marks a reviewed task as accepted, taking it out of the review queue. */
  ipcMain.handle('runs:approve', (_e, runId: string) => {
    const run = store.getRun(runId)
    if (!run) throw new Error('Task not found')
    if (run.deliveryStatus !== 'reviewable') throw new Error('This task is not awaiting review')

    const approved = store.updateRun(runId, { deliveryStatus: 'approved' })!
    recordSystemEvent(runId, `Approved on branch ${run.branchName}.`)
    send('run:updated', approved)
    return approved
  })

  /**
   * Applies a manual rebase plan. Anvil performs it directly, so the task does
   * not go back to running and no agent is involved.
   */
  ipcMain.handle('runs:rebase', async (_e, input: { runId: string; steps: RebaseStep[] }) => {
    const run = store.getRun(input.runId)
    if (!run) throw new Error('Task not found')
    if (runner.isRunning(input.runId)) throw new Error('This task is already running')
    if (!run.branchName || !run.baseCommit) throw new Error('This task has no branch to rebase')

    const project = store.getProjects().find((item) => item.id === run.projectId)
    if (!project) throw new Error('Project not found')

    const result = await gitDelivery.rebase(
      project.path,
      input.runId,
      run.branchName,
      run.baseCommit,
      input.steps
    )

    const kept = input.steps.filter((step) => step.action !== 'drop').length
    const dropped = input.steps.length - kept
    recordSystemEvent(
      input.runId,
      `Rebased ${input.steps.length} commits into ${result.commits.length}` +
        (dropped ? `, dropping ${dropped}.` : '.')
    )

    const updated = store.updateRun(input.runId, {
      headCommit: result.headCommit,
      filesChanged: result.filesChanged,
      additions: result.additions,
      deletions: result.deletions,
      // A rebase that drops every change leaves nothing to review.
      deliveryStatus: result.filesChanged > 0 ? run.deliveryStatus : 'no_changes'
    })!
    send('run:updated', updated)
    return updated
  })

  ipcMain.handle('runs:rebase-agent', async (_e, runId: string) => {
    const run = store.getRun(runId)
    if (!run) throw new Error('Task not found')
    if (runner.isRunning(runId)) throw new Error('This task is already running')
    if (!run.branchName || !run.baseCommit) throw new Error('This task has no branch to rebase')

    const project = store.getProjects().find((item) => item.id === run.projectId)
    if (!project) throw new Error('Project not found')

    const agent = getAgent(run.agentId)
    if (!agent) throw new Error(`Unknown agent: ${run.agentId}`)

    const reopened = await gitDelivery.reopen(project.path, runId, run.branchName)
    const running = store.updateRun(runId, {
      status: 'running',
      cwd: reopened.cwd,
      endedAt: undefined,
      exitCode: null,
      error: undefined,
      deliveryStatus: 'working',
      worktreePath: reopened.worktreePath,
      deliveryError: undefined
    })!
    send('run:updated', running)

    recordSystemEvent(runId, `Asked ${agent.label} to rebase this branch into one commit.`)
    const resumeSessionId = run.sessionId
    if (resumeSessionId && agent.resumeArgs) {
      recordSystemEvent(runId, `Resuming session ${resumeSessionId}.`)
    }

    setImmediate(() => {
      runner.start({
        runId,
        agent,
        prompt: agentRebasePrompt(run.baseCommit!),
        model: run.model,
        cwd: reopened.cwd,
        ...(resumeSessionId ? { resumeSessionId } : {})
      })
    })
    return running
  })

  ipcMain.handle('comments:list', (_e, runId: string) => store.getComments(runId))

  ipcMain.handle(
    'comments:add',
    (_e, input: { runId: string; file: string; side: RunComment['side']; lineNumber: number; body: string }) => {
      const body = input.body.trim()
      if (!body) throw new Error('A comment needs some text')
      store.addComment({
        id: randomUUID(),
        runId: input.runId,
        file: input.file,
        side: input.side,
        lineNumber: input.lineNumber,
        body,
        createdAt: Date.now(),
        sentAt: null
      })
      return store.getComments(input.runId)
    }
  )

  ipcMain.handle('comments:remove', (_e, input: { runId: string; id: string }) => {
    store.removeComment(input.id)
    return store.getComments(input.runId)
  })

  /**
   * Hands the pending review notes back to the agent that wrote the code. The
   * task returns to a running state on its own branch, in a worktree re-opened
   * for the purpose, resuming the original session when the CLI supports it.
   */
  ipcMain.handle('comments:send', async (_e, runId: string) => {
    const run = store.getRun(runId)
    if (!run) throw new Error('Task not found')
    if (runner.isRunning(runId)) throw new Error('This task is already running')
    if (!run.branchName) throw new Error('This task has no branch to review')

    const project = store.getProjects().find((item) => item.id === run.projectId)
    if (!project) throw new Error('Project not found')

    const agent = getAgent(run.agentId)
    if (!agent) throw new Error(`Unknown agent: ${run.agentId}`)

    const pending = store.getComments(runId).filter((comment) => comment.sentAt === null)
    if (!pending.length) throw new Error('There are no comments to send')

    const reopened = await gitDelivery.reopen(project.path, runId, run.branchName)
    const sent = store.markCommentsSent(runId, Date.now())

    const running = store.updateRun(runId, {
      status: 'running',
      cwd: reopened.cwd,
      endedAt: undefined,
      exitCode: null,
      error: undefined,
      deliveryStatus: 'working',
      worktreePath: reopened.worktreePath,
      deliveryError: undefined
    })!
    send('run:updated', running)

    recordSystemEvent(
      runId,
      `Sent ${sent.length} review ${sent.length === 1 ? 'comment' : 'comments'} back to ${agent.label}.`
    )

    const resumeSessionId = run.sessionId
    if (resumeSessionId && agent.resumeArgs) {
      recordSystemEvent(runId, `Resuming session ${resumeSessionId}.`)
    }

    setImmediate(() => {
      runner.start({
        runId,
        agent,
        prompt: `${GIT_SYSTEM_PROMPT}\n\n${reviewPrompt(sent)}`,
        model: run.model,
        cwd: reopened.cwd,
        ...(resumeSessionId ? { resumeSessionId } : {})
      })
    })
    return { run: running, comments: store.getComments(runId) }
  })

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
