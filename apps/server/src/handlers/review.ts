import { TaskStacks, requireStackMergeable } from '../tasks/task-stacks'
import type { HandlerRegistry } from '../handler-registry'
import { randomUUID } from 'node:crypto'
import { getAgent } from '../agents/registry'
import { draftCommitMessage, draftCommitMessageOrTitle } from '../agents/commit-message-draft'
import { resolveTaskWorkspace } from '../agents/workspace-execution'
import { withTaskOperation } from '../tasks/operations'
import { resumeTaskTurn } from '../tasks/resume'
import { mergeConflictRepairPrompt, reviewPrompt } from '../agents/task-prompts'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'
import type { BranchSyncStatus, Project, Task, TaskDiff, TaskMergeAndPushPreview, TaskMergeConflict, TaskMergeConflictSnapshot, TaskMergePreview, TaskPushPreview } from '@anvil/protocol/types'
import type { MergeConflictResult } from '../git/types'
import { taskStyle } from '@anvil/protocol/task-style'
import { isLocalQuickTask } from '@anvil/protocol/task-checkout'

const subjectLine = (message: string): string => message.trim().split(/\r?\n/, 1)[0]

interface ReviewHandlerDependencies extends TaskContext {
  recordSystemEvent: RecordSystemEvent
  requireFinishedTask: TaskExecution['requireFinishedTask']
  runMergeConflictRepair: TaskExecution['runMergeConflictRepair']
}

export function registerReviewHandlers(ipc: HandlerRegistry, {
  store, agentProcesses, gitDelivery, send, recordSystemEvent, requireFinishedTask,
  runMergeConflictRepair
}: ReviewHandlerDependencies): void {
  const shipOf = (conflict: TaskMergeConflict): { targetCommit: string; message: string } | undefined =>
    conflict.shipMessage ? { targetCommit: conflict.targetCommit, message: conflict.shipMessage } : undefined

  const requireReviewableTask = (taskId: string) => {
    requireFinishedTask(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    requireStackMergeable(store, task)
    if (task.deliveryStatus !== 'reviewable') throw new Error('This task is not awaiting review')
    if (!task.branchName || !task.headCommit) throw new Error('This task has no finalized branch to merge')
    const project = store.getProjects(task?.workspaceId).find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return { task, project, branchName: task.branchName, headCommit: task.headCommit }
  }

  const requireApprovedTask = (taskId: string) => {
    requireFinishedTask(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (task.deliveryStatus !== 'approved') throw new Error('Ship this task before pushing its target branch')
    if (!task.headCommit) throw new Error('This task has no finalized commit to push')
    const project = store.getProjects(task.workspaceId).find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return { task, project, headCommit: task.shippedCommit ?? task.headCommit }
  }

  const requireQuickTask = (taskId: string) => {
    requireFinishedTask(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (!isLocalQuickTask(task)) throw new Error('Only local Quick tasks can be committed directly')
    if (task.deliveryStatus !== 'reviewable') throw new Error('This Quick task has nothing to ship')
    if (!task.reviewPaths?.length) throw new Error('This task has no delivered code')
    const project = store.getProjects(task.workspaceId).find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return { task, project }
  }

  const requireMergeConflictTask = (taskId: string, conflictId: string) => {
    requireFinishedTask(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    const conflict = task.mergeConflict
    if (task.deliveryStatus !== 'merge_conflict' || !conflict || conflict.id !== conflictId) {
      throw new Error('The merge conflict session changed. Refresh the task before continuing.')
    }
    if (conflict.taskId !== task.id || conflict.workspaceId !== task.workspaceId || conflict.projectId !== task.projectId ||
      conflict.sourceBranch !== task.branchName || conflict.sourceCommit !== task.headCommit) {
      throw new Error('The paused merge has invalid task ownership metadata. Inspect the repository before continuing.')
    }
    if (conflict.requestedAction === 'merge_and_push' && (!conflict.pushPreview ||
      conflict.pushPreview.targetBranch !== conflict.targetBranch || conflict.pushPreview.targetCommit !== conflict.targetCommit)) {
      throw new Error('The paused Merge & Push operation has invalid push ownership metadata. Inspect the task before continuing.')
    }
    const project = store.getProjects(task.workspaceId).find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return { task, project, conflict }
  }

  const requireProjectDeliveryAvailable = async (project: Project, taskId: string): Promise<void> => {
    const owner = store.getTasks().find((task) => task.projectId === project.id &&
      (task.deliveryStatus === 'merge_conflict' || task.mergeConflict))
    if (!owner) return
    if (!owner.mergeConflict || owner.deliveryStatus !== 'merge_conflict') {
      throw new Error('The paused merge has invalid task ownership metadata. Inspect the repository before continuing.')
    }
    const conflict = owner.mergeConflict
    if (owner.workspaceId !== conflict.workspaceId || owner.projectId !== conflict.projectId || owner.id !== conflict.taskId) {
      throw new Error('The paused merge has invalid task ownership metadata. Inspect the repository before continuing.')
    }
    await gitDelivery.validateMergeConflict(project.path, conflict)
    throw new Error(owner.id === taskId
      ? 'This task has merge conflicts with the target branch.'
      : 'Another task owns a paused merge in this project. Resolve or abort it before delivering this task.')
  }

  const pauseMerge = (
    task: Task,
    preview: TaskMergePreview,
    result: MergeConflictResult,
    requestedAction: TaskMergeConflict['requestedAction'],
    pushPreview?: TaskPushPreview,
    shipMessage?: string
  ): Task => {
    if (task.projectId === undefined) throw new Error('Git delivery requires a project')
    const mergeConflict: TaskMergeConflict = {
      id: randomUUID(),
      taskId: task.id,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      repositoryRoot: result.repositoryRoot,
      sourceBranch: preview.sourceBranch,
      targetBranch: preview.targetBranch,
      sourceCommit: preview.sourceCommit,
      targetCommit: preview.targetCommit,
      mergeHeadCommit: result.mergeHeadCommit,
      conflictedFiles: result.conflictedFiles,
      requestedAction,
      ...(pushPreview ? { pushPreview } : {}),
      ...(shipMessage ? { shipMessage } : {}),
      createdAt: Date.now()
    }
    const conflicted = store.updateTask(task.id, {
      deliveryStatus: 'merge_conflict',
      mergeConflict,
      reviewedAt: undefined,
      deliveryError: undefined
    })
    if (!conflicted) throw new Error('Task was deleted')
    recordSystemEvent(task.id, `Merge paused: ${result.conflictedFiles.length} file${result.conflictedFiles.length === 1 ? '' : 's'} conflict with ${preview.targetBranch}.`)
    send('task:updated', conflicted)
    return conflicted
  }

  const finishMerge = async (
    task: Task,
    project: Project,
    mergedCommit: string,
    targetBranch: string,
    sourceCommit: string,
    requestedAction: TaskMergeConflict['requestedAction'],
    pushPreview: TaskPushPreview | undefined,
    mergeEvent: string,
    check: (expected?: Task) => Task,
    ship?: { targetCommit: string; message: string }
  ): Promise<Task> => {
    if (requestedAction === 'merge_and_push' && !pushPreview) {
      throw new Error('The paused Merge & Push operation has no push ownership metadata.')
    }
    const finalCommit = ship
      ? await gitDelivery.squashMergedCommit(project.path, { targetBranch, targetCommit: ship.targetCommit, mergedCommit }, ship.message, () => check())
      : mergedCommit
    let approved = store.updateTask(task.id, {
      deliveryStatus: 'approved',
      reviewedAt: Date.now(),
      mergeConflict: undefined,
      deliveryError: undefined,
      ...(ship ? { shippedCommit: finalCommit, shippedHead: sourceCommit, pushedCommit: undefined } : {})
    })
    if (!approved) throw new Error('Task was deleted')
    recordSystemEvent(task.id, ship
      ? `Shipped to ${targetBranch} as ${finalCommit.slice(0, 8)}: ${subjectLine(ship.message)}`
      : mergeEvent)
    send('task:updated', approved)

    let pushError: unknown
    if (requestedAction === 'merge_and_push') {
      try {
        await gitDelivery.push(project.path, { ...pushPreview!, targetBranch, targetCommit: finalCommit }, ship ? finalCommit : sourceCommit, () => {
          check(approved)
          requireApprovedTask(task.id)
        })
        recordSystemEvent(task.id, `Pushed ${targetBranch} at ${finalCommit} to origin.`)
        approved = (ship ? store.updateTask(task.id, { pushedCommit: finalCommit }) : undefined) ?? approved
        send('task:updated', approved)
      } catch (error) {
        pushError = error
        recordSystemEvent(task.id, `The task was merged locally, but ${targetBranch} could not be pushed to origin: ${error instanceof Error ? error.message : String(error)}`, 'delivery', 'error')
      }
    }

    try {
      await new TaskStacks({ store, agentProcesses, gitDelivery, send }).restackChildren(task.id)
    } catch (error) {
      if (!pushError) throw error
      recordSystemEvent(task.id, `Child restacking also failed after the local merge: ${error instanceof Error ? error.message : String(error)}`, 'delivery', 'error')
    }
    if (pushError) throw pushError
    return approved
  }

  const getReviewableMergePreview = async (taskId: string): Promise<TaskMergePreview> => {
    const { project, branchName, headCommit } = requireReviewableTask(taskId)
    await requireProjectDeliveryAvailable(project, taskId)
    const preview = await gitDelivery.getMergePreview(project.path, branchName)
    if (preview.sourceCommit !== headCommit) {
      throw new Error('The task branch changed after review. Refresh or restore its finalized commit before merging.')
    }
    return preview
  }

  ipc.handle('tasks:merge-preview', async (taskId: string): Promise<TaskMergePreview> => {
    return getReviewableMergePreview(taskId)
  })

  ipc.handle('tasks:approve', async (input): Promise<Task> => {
    const { taskId, preview } = input
    return withTaskOperation(store, taskId, 'merge', async (check) => {
      const { task, project, branchName, headCommit } = requireReviewableTask(taskId)
      await requireProjectDeliveryAvailable(project, taskId)
      if (preview.sourceCommit !== headCommit) throw new Error('The task branch changed after review. Refresh the merge details.')
      const guard = () => {
        check()
        requireReviewableTask(taskId)
      }
      const result = await gitDelivery.merge(project.path, branchName, preview, guard)
      guard()
      if (result.status === 'conflicted') return pauseMerge(task, preview, result, 'merge')
      return finishMerge(task, project, result.commit, preview.targetBranch, headCommit, 'merge', undefined,
        `Merged ${branchName} into ${preview.targetBranch} with git merge, bringing in ${preview.commitCount} commit${preview.commitCount === 1 ? '' : 's'}.`, check)
    })
  })

  ipc.handle('tasks:merge-and-push-preview', async (taskId: string): Promise<TaskMergeAndPushPreview> => {
    const { project } = requireReviewableTask(taskId)
    const mergePreview = await getReviewableMergePreview(taskId)
    const pushPreview = await gitDelivery.getPushPreview(project.path, mergePreview.targetBranch)
    if (pushPreview.targetCommit !== mergePreview.targetCommit) {
      throw new Error('The target branch changed while loading the delivery details. Refresh and try again.')
    }
    return {
      ...mergePreview,
      remote: pushPreview.remote,
      remoteTargetCommit: pushPreview.remoteTargetCommit,
      remoteUrlHash: pushPreview.remoteUrlHash
    }
  })

  ipc.handle('tasks:merge-and-push', async (input): Promise<Task> => {
    const { taskId, preview } = input
    return withTaskOperation(store, taskId, 'merge', async (check) => {
      const { task, project, branchName, headCommit } = requireReviewableTask(taskId)
      await requireProjectDeliveryAvailable(project, taskId)
      if (preview.sourceCommit !== headCommit) throw new Error('The task branch changed after review. Refresh the delivery details.')
      const reviewableGuard = () => {
        check()
        requireReviewableTask(taskId)
      }
      const result = await gitDelivery.merge(project.path, branchName, preview, reviewableGuard)
      reviewableGuard()
      if (result.status === 'conflicted') {
        return pauseMerge(task, preview, result, 'merge_and_push', {
          targetBranch: preview.targetBranch,
          targetCommit: preview.targetCommit,
          remote: preview.remote,
          remoteTargetCommit: preview.remoteTargetCommit,
          remoteUrlHash: preview.remoteUrlHash
        })
      }
      return finishMerge(task, project, result.commit, preview.targetBranch, headCommit, 'merge_and_push', {
        targetBranch: preview.targetBranch,
        targetCommit: preview.targetCommit,
        remote: preview.remote,
        remoteTargetCommit: preview.remoteTargetCommit,
        remoteUrlHash: preview.remoteUrlHash
      }, `Merged ${branchName} into ${preview.targetBranch} with git merge, bringing in ${preview.commitCount} commit${preview.commitCount === 1 ? '' : 's'}.`, check)
    })
  })

  ipc.handle('tasks:merge-conflict', (input): Promise<TaskMergeConflictSnapshot> =>
    withTaskOperation(store, input.taskId, 'merge', async (check) => {
      const { project, conflict } = requireMergeConflictTask(input.taskId, input.conflictId)
      check()
      const snapshot = await gitDelivery.getMergeConflict(project.path, conflict)
      requireMergeConflictTask(input.taskId, input.conflictId)
      check()
      return snapshot
    }))

  ipc.handle('tasks:merge-conflict-save', (input): Promise<TaskMergeConflictSnapshot> =>
    withTaskOperation(store, input.taskId, 'merge', async (check) => {
      const { project, conflict } = requireMergeConflictTask(input.taskId, input.conflictId)
      const guard = () => {
        check()
        requireMergeConflictTask(input.taskId, input.conflictId)
      }
      const snapshot = await gitDelivery.saveMergeConflictFile(
        project.path, conflict, input.path, input.contents, input.expectedContentsHash, guard
      )
      guard()
      return snapshot
    }))

  ipc.handle('tasks:merge-conflict-complete', (input): Promise<Task> =>
    withTaskOperation(store, input.taskId, 'merge', async (check) => {
      const { task, project, conflict } = requireMergeConflictTask(input.taskId, input.conflictId)
      const guard = () => {
        check()
        requireMergeConflictTask(input.taskId, input.conflictId)
      }
      const mergedCommit = await gitDelivery.completeMergeConflict(project.path, conflict, guard)
      guard()
      return finishMerge(task, project, mergedCommit, conflict.targetBranch, conflict.sourceCommit,
        conflict.requestedAction, conflict.pushPreview,
        `Completed the paused merge of ${conflict.sourceBranch} into ${conflict.targetBranch} at ${mergedCommit}.`, check, shipOf(conflict))
    }))

  ipc.handle('tasks:merge-conflict-fix-agent', (input): Promise<Task> =>
    withTaskOperation(store, input.taskId, 'merge-repair', async (check) => {
      const { task, project, conflict } = requireMergeConflictTask(input.taskId, input.conflictId)
      const guard = () => {
        check()
        requireMergeConflictTask(input.taskId, input.conflictId)
      }
      const snapshot = await gitDelivery.getMergeConflict(project.path, conflict)
      guard()
      const unresolvedFiles = snapshot.files.map((file) => file.path)
      if (!unresolvedFiles.length) throw new Error('No unresolved files remain. Complete the paused merge instead.')
      const prompt = mergeConflictRepairPrompt(conflict, unresolvedFiles)
      const agent = getAgent(task.agentId)
      recordSystemEvent(task.id, `Starting ${agent?.label ?? task.agentLabel} to repair ${unresolvedFiles.length} merge conflict${unresolvedFiles.length === 1 ? '' : 's'} in ${conflict.targetBranch}.`)
      send('task:updated', task)
      let exit
      try {
        exit = await runMergeConflictRepair(task.id, { cwd: project.path, prompt, beforeDispatch: guard })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'Task operation was cancelled') {
          recordSystemEvent(task.id, `Agent merge repair was cancelled before starting. The merge into ${conflict.targetBranch} remains paused.`)
          const current = store.getTask(task.id)
          if (!current) throw new Error('Task was deleted')
          send('task:updated', current)
          return current
        }
        recordSystemEvent(task.id, `Could not start agent merge repair: ${message}`, 'delivery', 'error')
        const current = store.getTask(task.id)
        if (current) send('task:updated', current)
        throw error
      }
      const current = store.getTask(task.id)
      if (!current) throw new Error('Task was deleted')
      if (exit.cancelled) {
        recordSystemEvent(task.id, `Agent merge repair was cancelled. The merge into ${conflict.targetBranch} remains paused.`)
        send('task:updated', current)
        return current
      }
      if (exit.code !== 0) {
        recordSystemEvent(task.id, `Agent merge repair failed${exit.error ? `: ${exit.error}` : '.'} The merge into ${conflict.targetBranch} remains paused.`, 'delivery', 'error')
        send('task:updated', current)
        return current
      }
      try {
        guard()
        const mergedCommit = await gitDelivery.completeMergeConflict(project.path, conflict, guard)
        guard()
        return finishMerge(task, project, mergedCommit, conflict.targetBranch, conflict.sourceCommit,
          conflict.requestedAction, conflict.pushPreview,
          `Agent completed the paused merge of ${conflict.sourceBranch} into ${conflict.targetBranch} at ${mergedCommit}.`, check, shipOf(conflict))
      } catch (error) {
        const latest = store.getTask(task.id)
        if (!latest || latest.deliveryStatus !== 'merge_conflict' || latest.mergeConflict?.id !== conflict.id) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'Task operation was cancelled') {
          recordSystemEvent(task.id, `Agent merge repair was cancelled. The merge into ${conflict.targetBranch} remains paused.`)
        } else {
          recordSystemEvent(task.id, `Agent merge repair is incomplete: ${message} The merge into ${conflict.targetBranch} remains paused.`, 'delivery', 'error')
        }
        send('task:updated', latest)
        return latest
      }
    }))

  ipc.handle('tasks:merge-conflict-abort', (input): Promise<Task> =>
    withTaskOperation(store, input.taskId, 'merge', async (check) => {
      const { task, project, conflict } = requireMergeConflictTask(input.taskId, input.conflictId)
      const guard = () => {
        check()
        requireMergeConflictTask(input.taskId, input.conflictId)
      }
      await gitDelivery.abortMergeConflict(project.path, conflict, guard)
      guard()
      const reviewable = store.updateTask(task.id, {
        deliveryStatus: 'reviewable',
        mergeConflict: undefined,
        reviewedAt: undefined,
        deliveryError: undefined
      })
      if (!reviewable) throw new Error('Task was deleted')
      recordSystemEvent(task.id, `Aborted the paused merge into ${conflict.targetBranch}. The task is ready to ship again.`)
      send('task:updated', reviewable)
      return reviewable
    }))

  ipc.handle('tasks:push-preview', async (taskId: string): Promise<TaskPushPreview> => {
    const { project, headCommit } = requireApprovedTask(taskId)
    return gitDelivery.getPushPreview(project.path, undefined, headCommit)
  })

  ipc.handle('tasks:push', async (input): Promise<Task> => {
    const { taskId, preview } = input
    return withTaskOperation(store, taskId, 'push', async (check) => {
      const { project, headCommit } = requireApprovedTask(taskId)
      try {
        await gitDelivery.push(project.path, preview, headCommit, () => {
          check()
          requireApprovedTask(taskId)
        })
      } catch (error) {
        recordSystemEvent(taskId, `Could not push ${preview.targetBranch} to origin: ${error instanceof Error ? error.message : String(error)}`, 'delivery', 'error')
        throw error
      }
      const task = store.updateTask(taskId, { pushedCommit: headCommit }) ?? requireApprovedTask(taskId).task
      recordSystemEvent(taskId, `Pushed ${preview.targetBranch} at ${preview.targetCommit} to origin.`)
      send('task:updated', task)
      return task
    })
  })

  ipc.handle('tasks:draft-commit-message', async ({ taskId, message }): Promise<string> => {
    return withTaskOperation(store, taskId, 'draft', async (check) => {
      const current = store.getTask(taskId)
      if (!current) throw new Error('Task not found')
      let diff: TaskDiff
      let task: Task
      if (isLocalQuickTask(current)) {
        const quick = requireQuickTask(taskId)
        task = quick.task
        diff = await gitDelivery.getWorkingTreeDiff(quick.project.path, task.reviewPaths!)
      } else {
        const reviewable = requireReviewableTask(taskId)
        task = reviewable.task
        const base = task.baseCommit ?? (await gitDelivery.getMergePreview(reviewable.project.path, reviewable.branchName)).targetCommit
        diff = await gitDelivery.getDiff(reviewable.project.path, base, reviewable.headCommit)
      }
      check()
      const workspace = resolveTaskWorkspace(store, task.id)
      return await draftCommitMessage(agentProcesses, workspace, task, diff, message, store.getTaskExecution(taskId)?.reasoningEffort)
    })
  })

  const reconcileOverlappingQuickTasks = async (committed: Task, project: Project, headCommit: string): Promise<void> => {
    const committedPaths = new Set(committed.reviewPaths)
    const siblings = store.getTasks(committed.workspaceId).filter((task) => task.id !== committed.id &&
      task.projectId === committed.projectId && taskStyle(task) === 'quick' && task.checkoutMode === 'local' &&
      task.deliveryStatus === 'reviewable' && task.reviewPaths?.some((path) => committedPaths.has(path)))
    for (const sibling of siblings) {
      try {
        const diff = await gitDelivery.getWorkingTreeDiff(project.path, sibling.reviewPaths!)
        if (store.getTask(sibling.id)?.deliveryStatus !== 'reviewable') continue
        const updated = diff.patch
          ? store.updateTask(sibling.id, {
            reviewPaths: diff.paths,
            filesChanged: diff.filesChanged,
            additions: diff.additions,
            deletions: diff.deletions
          })
          : store.updateTask(sibling.id, {
            deliveryStatus: 'approved',
            headCommit,
            pushedCommit: undefined,
            reviewedAt: Date.now(),
            deliveryError: undefined
          })
        if (!updated) continue
        if (!diff.patch) recordSystemEvent(sibling.id, `Changes were committed with "${committed.title}" as ${headCommit.slice(0, 8)}.`)
        send('task:updated', updated)
      } catch {
        continue
      }
    }
  }

  const refreshLocalQuickTasks = async (task: Task, project: Project): Promise<void> => {
    const locals = store.getTasks(task.workspaceId).filter((item) => item.projectId === task.projectId &&
      taskStyle(item) === 'quick' && item.checkoutMode === 'local' && item.deliveryStatus === 'reviewable' && item.reviewPaths?.length)
    for (const local of locals) {
      try {
        const diff = await gitDelivery.getWorkingTreeDiff(project.path, local.reviewPaths!)
        if (!diff.patch || store.getTask(local.id)?.deliveryStatus !== 'reviewable') continue
        const updated = store.updateTask(local.id, {
          reviewPaths: diff.paths,
          filesChanged: diff.filesChanged,
          additions: diff.additions,
          deletions: diff.deletions
        })
        if (updated) send('task:updated', updated)
      } catch {
        continue
      }
    }
  }

  ipc.handle('tasks:sync-status', async (taskId: string): Promise<BranchSyncStatus> => {
    const { project } = requireQuickTask(taskId)
    return gitDelivery.getSyncStatus(project.path)
  })

  ipc.handle('tasks:pull', async ({ taskId, branch, localCommit, remoteCommit }): Promise<BranchSyncStatus> => {
    return withTaskOperation(store, taskId, 'pull', async (check) => {
      const { task, project } = requireQuickTask(taskId)
      const status = await gitDelivery.pull(project.path, { branch, localCommit, remoteCommit }, () => {
        check()
        requireQuickTask(taskId)
      })
      recordSystemEvent(task.id, `Pulled ${branch} from origin, fast-forwarding ${localCommit.slice(0, 8)} to ${remoteCommit.slice(0, 8)}.`)
      await refreshLocalQuickTasks(task, project)
      return status
    })
  })

  const commitLocalTask = async (
    taskId: string,
    push: boolean,
    resolveMessage: (task: Task, project: Project) => Promise<string>,
    check: (expected?: Task) => Task,
    shipped: boolean
  ): Promise<Task> => {
    const { task, project } = requireQuickTask(taskId)
    if (push) {
      const sync = await gitDelivery.getSyncStatus(project.path)
      check()
      if (sync.behind > 0) {
        throw new Error(`origin/${sync.branch} has ${sync.behind} new commit${sync.behind === 1 ? '' : 's'}. Pull before committing and pushing.`)
      }
    }
    const message = await resolveMessage(task, project)
    check()
    requireQuickTask(taskId)
    const headCommit = await gitDelivery.commitPaths(project.path, task.reviewPaths!, message)
    check()
    const committed = store.updateTask(task.id, {
      deliveryStatus: 'approved',
      headCommit,
      pushedCommit: undefined,
      reviewedAt: Date.now(),
      deliveryError: undefined,
      ...(shipped ? { shippedCommit: headCommit } : {})
    })
    if (!committed) throw new Error('Task was deleted')
    recordSystemEvent(task.id, shipped
      ? `Shipped ${task.reviewPaths!.length} task file${task.reviewPaths!.length === 1 ? '' : 's'} as ${headCommit.slice(0, 8)}: ${subjectLine(message)}`
      : `Committed ${task.reviewPaths!.length} task file${task.reviewPaths!.length === 1 ? '' : 's'} as ${headCommit.slice(0, 8)}.`)
    send('task:updated', committed)
    await reconcileOverlappingQuickTasks(committed, project, headCommit)
    if (!push) return committed
    const preview = await gitDelivery.getPushPreview(project.path, undefined, headCommit)
    await gitDelivery.push(project.path, preview, headCommit, () => {
      check(committed)
      requireApprovedTask(task.id)
    })
    recordSystemEvent(task.id, `Pushed ${preview.targetBranch} at ${headCommit} to origin.`)
    const pushed = store.updateTask(task.id, { pushedCommit: headCommit })
    if (!pushed) throw new Error('Task was deleted')
    send('task:updated', pushed)
    return pushed
  }

  ipc.handle('tasks:commit-quick', async ({ taskId, push, message }): Promise<Task> => {
    return withTaskOperation(store, taskId, 'commit', (check) =>
      commitLocalTask(taskId, push, async (task) => message?.trim() || task.title, check, false))
  })

  const shipMessage = async (task: Task, diff: () => Promise<TaskDiff>, requested?: string): Promise<string> => {
    const message = requested?.trim()
    if (message) return message
    const workspace = resolveTaskWorkspace(store, task.id)
    const draft = await draftCommitMessageOrTitle(async () => draftCommitMessage(agentProcesses, workspace, task, await diff(), '',
      store.getTaskExecution(task.id)?.reasoningEffort), task)
    if (!draft.generated) recordSystemEvent(task.id, `${task.agentLabel} could not write a commit message, so the task title was used.`)
    return draft.message
  }

  ipc.handle('tasks:ship', async ({ taskId, push, message }): Promise<Task> => {
    return withTaskOperation(store, taskId, 'ship', async (check) => {
      const current = store.getTask(taskId)
      if (!current) throw new Error('Task not found')
      const project = store.getProjects(current.workspaceId).find((item) => item.id === current.projectId)
      if (!project) throw new Error('Project not found')
      const pushNow = push ?? project.shipPushes
      if (isLocalQuickTask(current)) {
        return commitLocalTask(taskId, pushNow, (task, local) =>
          shipMessage(task, () => gitDelivery.getWorkingTreeDiff(local.path, task.reviewPaths!), message), check, true)
      }
      const { task, branchName, headCommit } = requireReviewableTask(taskId)
      await requireProjectDeliveryAvailable(project, taskId)
      const subject = await shipMessage(task, async () => {
        const base = task.baseCommit ?? (await gitDelivery.getMergePreview(project.path, branchName)).targetCommit
        return gitDelivery.getDiff(project.path, base, headCommit)
      }, message)
      check()
      const preview = await getReviewableMergePreview(taskId)
      const pushPreview = pushNow ? await gitDelivery.getPushPreview(project.path, preview.targetBranch) : undefined
      if (pushPreview && pushPreview.targetCommit !== preview.targetCommit) {
        throw new Error('The target branch changed while preparing to ship. Try again.')
      }
      const guard = () => {
        check()
        requireReviewableTask(taskId)
      }
      guard()
      const result = await gitDelivery.merge(project.path, branchName, preview, guard)
      guard()
      const action = pushNow ? 'merge_and_push' as const : 'merge' as const
      if (result.status === 'conflicted') return pauseMerge(task, preview, result, action, pushPreview, subject)
      return finishMerge(task, project, result.commit, preview.targetBranch, headCommit, action, pushPreview,
        `Merged ${branchName} into ${preview.targetBranch}.`, check, { targetCommit: preview.targetCommit, message: subject })
    })
  })

  ipc.handle('comments:list', (taskId: string) => store.getComments(taskId))

  ipc.handle(
    'comments:add',
    (input) => {
      if (!store.getTask(input.taskId)) throw new Error('Task not found')
      const body = input.body.trim()
      store.addComment({
        id: randomUUID(),
        taskId: input.taskId,
        file: input.file,
        side: input.side,
        lineNumber: input.lineNumber,
        body,
        createdAt: Date.now(),
        sentAt: null
      })
      return store.getComments(input.taskId)
    }
  )

  ipc.handle('comments:remove', (input) => {
    if (!store.getTask(input.taskId)) throw new Error('Task not found')
    if (!store.getComments(input.taskId).some((comment) => comment.id === input.id)) {
      throw new Error('Comment does not belong to this task')
    }
    store.removeComment(input.id)
    return store.getComments(input.taskId)
  })

  ipc.handle('comments:send', async (taskId: string) => {
    return withTaskOperation(store, taskId, 'review', async (check) => {
      requireFinishedTask(taskId)
      const pending = store.getComments(taskId).filter((comment) => comment.sentAt === null)
      if (!pending.length) throw new Error('There are no comments to send')
      const running = await resumeTaskTurn({ store, agentProcesses, gitDelivery, send }, {
        check,
        validate: (task) => {
          requireFinishedTask(taskId)
          if (!task.branchName) throw new Error('This task has no branch to review')
        },
        prompt: () => reviewPrompt(pending)
      })
      const sent = store.markCommentsSent(taskId, Date.now(), pending.map((comment) => comment.id))
      recordSystemEvent(taskId, `Sent ${sent.length} review ${sent.length === 1 ? 'comment' : 'comments'} back to ${getAgent(running.agentId)!.label}.`)
      return { task: running, comments: store.getComments(taskId) }
    })
  })
}
