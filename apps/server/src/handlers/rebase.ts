import type { HandlerRegistry } from '../handler-registry'
import { withTaskOperation } from '../tasks/operations'
import { resumeTaskTurn } from '../tasks/resume'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'

interface RebaseHandlerDependencies extends TaskContext {
  recordSystemEvent: RecordSystemEvent
}

export function registerRebaseHandlers(ipc: HandlerRegistry, {
  store, agentProcesses, gitDelivery, send
}: RebaseHandlerDependencies): void {
  ipc.handle('tasks:rebase-agent', async (taskId: string) => {
    return withTaskOperation(store, taskId, 'rebase', (check) => resumeTaskTurn(
      { store, agentProcesses, gitDelivery, send }, {
        check,
        gitInstructions: false,
        allowRestack: true,
        validate: (task) => {
          if (!task.restackState || !task.restackTarget) throw new Error('This task has no restack to resolve')
          if (task.status === 'running') throw new Error('Wait for the task to stop before resolving its restack')
          if (!task.branchName || !task.baseCommit) throw new Error('This task has no branch to restack')
        },
        prompt: (task) => `Resolve this task's restack onto commit ${task.restackTarget!.commit}. Run git rebase --onto ${task.restackTarget!.commit} ${task.restackTarget!.oldBase ?? task.baseCommit}. Resolve conflicts preserving both changes, git add resolved files, and continue with GIT_EDITOR=true git rebase --continue until finished. Do not skip commits or reset away changes. Leave a clean worktree. Anvil will verify the target ancestry and refresh the diff. Do not change issue statuses during this repair.`
      }
    ))
  })
}
