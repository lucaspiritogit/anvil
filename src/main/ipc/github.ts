import { resolveTaskWorkspace } from '../agents/workspace-execution'
import { openExternalPullRequest, type RendererIpc } from '../renderer-security'
import type { GitHubCredentialStatus, PullRequestInfo, PullRequestPreview } from '../../shared/types'
import { draftPullRequestField } from '../agents/pull-request-draft'
import { GitHubClient } from '../github-client'
import type { GitHubCredentials } from '../github-credentials'
import { GitHubPullRequests } from '../github-pull-requests'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import { withTaskOperation } from '../tasks/operations'
import type { TaskExecution } from '../tasks/task-execution'

interface GitHubHandlerDependencies extends TaskContext {
  credentials: GitHubCredentials | ((workspaceId: string) => GitHubCredentials)
  client?: GitHubClient
  recordSystemEvent: RecordSystemEvent
  requireFinishedTask: TaskExecution['requireFinishedTask']
  refreshPullRequests?: (workspaceId: string) => void
  githubCredentialsChanged?: (workspaceId: string) => void
}

export function registerGitHubHandlers(ipc: RendererIpc, {
  store, gitDelivery, agentProcesses, send, credentials, recordSystemEvent, requireFinishedTask, refreshPullRequests, githubCredentialsChanged, client = new GitHubClient()
}: GitHubHandlerDependencies): void {
  const workspaceCredentials = (workspaceId: string): GitHubCredentials => typeof credentials === 'function' ? credentials(workspaceId) : credentials
  const pullRequests = (workspaceId: string): GitHubPullRequests => new GitHubPullRequests(gitDelivery, workspaceCredentials(workspaceId), client)
  const requireTask = (taskId: string) => {
    requireFinishedTask(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (!['reviewable', 'approved'].includes(task.deliveryStatus) || !task.branchName || !task.baseCommit || !task.headCommit) {
      throw new Error('This task has no finished branch ready for a PR.')
    }
    const project = store.getProjects(task?.workspaceId).find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return { task, project, branchName: task.branchName, baseCommit: task.baseCommit, headCommit: task.headCommit }
  }

  ipc.handle('github:credential-status', (): Promise<GitHubCredentialStatus> => workspaceCredentials(store.getActiveWorkspace().id).status())
  ipc.handle('github:set-token', async (_event, value: string): Promise<GitHubCredentialStatus> => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 1024 || /\s/.test(value.trim())) throw new Error('Enter a valid personal GitHub token.')
    const workspaceId = store.getActiveWorkspace().id
    const ownerCredentials = workspaceCredentials(workspaceId)
    const token = value.trim()
    await client.account(token)
    const status = await ownerCredentials.setToken(token)
    githubCredentialsChanged?.(workspaceId)
    return status
  })
  ipc.handle('github:remove-token', async (): Promise<GitHubCredentialStatus> => {
    const workspaceId = store.getActiveWorkspace().id
    const status = await workspaceCredentials(workspaceId).removeToken()
    githubCredentialsChanged?.(workspaceId)
    return status
  })
  ipc.handle('github:pr-preview', async (_event, taskId: string): Promise<PullRequestPreview> => {
    const { task, project, branchName } = requireTask(taskId)
    return pullRequests(task.workspaceId).preview(project.path, branchName)
  })
  ipc.handle('github:open-pr', async (_event, input): Promise<PullRequestInfo> => {
    const { taskId, preview, title, description } = input
    return withTaskOperation(store, taskId, 'pull-request', async (check) => {
      const { task, project, branchName, headCommit } = requireTask(taskId)
      const guard = () => {
        check()
        requireTask(taskId)
      }
      const result = await pullRequests(task.workspaceId).open(project.path, branchName, preview, title, description, guard)
      guard()
      if (store.getTask(taskId)) {
        store.linkPullRequest(taskId, {
          repository: preview.repository, number: result.number, headSha: headCommit,
          sourceBranch: result.sourceBranch, targetBranch: result.targetBranch
        })
        const updated = store.getTask(taskId)
        if (updated) send('task:updated', updated)
        refreshPullRequests?.(task.workspaceId)
      }
      recordSystemEvent(taskId, `${result.existing ? 'Existing' : 'Opened'} PR #${result.number}: ${result.title}\n${result.url}\n${result.sourceBranch} into ${result.targetBranch}, by ${result.author}.`)
      return result
    })
  })
  ipc.handle('github:draft-pr-field', async (_event, input): Promise<string> => {
    const { taskId, field, title, description } = input
    return withTaskOperation(store, taskId, 'draft', async (check) => {
      const { task, project, baseCommit, headCommit } = requireTask(taskId)
      const workspace = resolveTaskWorkspace(store, task.id)
      const diff = await gitDelivery.getDiff(project.path, baseCommit, headCommit)
      check()
      requireTask(taskId)
      return await draftPullRequestField(agentProcesses, workspace, task, diff, field, title, description, store.getTaskExecution(taskId)?.reasoningEffort)
    })
  })
  ipc.handle('github:open-pr-url', async (_event, url: string): Promise<void> => {
    await openExternalPullRequest(url)
  })
}
