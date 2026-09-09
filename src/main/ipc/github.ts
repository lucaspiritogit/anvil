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
  credentials: GitHubCredentials
  client?: GitHubClient
  recordSystemEvent: RecordSystemEvent
  requireFinishedTask: TaskExecution['requireFinishedTask']
  refreshPullRequests?: () => void
  githubCredentialsChanged?: () => void
}

export function registerGitHubHandlers(ipc: RendererIpc, {
  store, gitDelivery, agentProcesses, credentials, recordSystemEvent, requireFinishedTask, refreshPullRequests, githubCredentialsChanged, client = new GitHubClient()
}: GitHubHandlerDependencies): void {
  const pullRequests = new GitHubPullRequests(gitDelivery, credentials, client)
  const requireTask = (taskId: string) => {
    requireFinishedTask(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (!['reviewable', 'approved'].includes(task.deliveryStatus) || !task.branchName || !task.baseCommit || !task.headCommit) {
      throw new Error('This task has no finished branch ready for a PR.')
    }
    const project = store.getProjects().find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return { task, project, branchName: task.branchName, baseCommit: task.baseCommit, headCommit: task.headCommit }
  }

  ipc.handle('github:credential-status', (): Promise<GitHubCredentialStatus> => credentials.status())
  ipc.handle('github:set-token', async (_event, value: string): Promise<GitHubCredentialStatus> => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 1024 || /\s/.test(value.trim())) throw new Error('Enter a valid personal GitHub token.')
    const token = value.trim()
    await client.account(token)
    const status = await credentials.setToken(token)
    githubCredentialsChanged?.()
    return status
  })
  ipc.handle('github:remove-token', async (): Promise<GitHubCredentialStatus> => {
    const status = await credentials.removeToken()
    githubCredentialsChanged?.()
    return status
  })
  ipc.handle('github:pr-preview', async (_event, taskId: string): Promise<PullRequestPreview> => {
    const { project, branchName } = requireTask(taskId)
    return pullRequests.preview(project.path, branchName)
  })
  ipc.handle('github:open-pr', async (_event, input): Promise<PullRequestInfo> => {
    const { taskId, preview, title, description } = input
    return withTaskOperation(store, taskId, 'pull-request', async (check) => {
      const { project, branchName, headCommit } = requireTask(taskId)
      const guard = () => {
        check()
        requireTask(taskId)
      }
      const result = await pullRequests.open(project.path, branchName, preview, title, description, guard)
      guard()
      if (store.getTask(taskId)) {
        store.linkPullRequest(taskId, {
          repository: preview.repository, number: result.number, headSha: headCommit,
          sourceBranch: result.sourceBranch, targetBranch: result.targetBranch
        })
        refreshPullRequests?.()
      }
      recordSystemEvent(taskId, `${result.existing ? 'Existing' : 'Opened'} PR #${result.number}: ${result.title}\n${result.url}\n${result.sourceBranch} into ${result.targetBranch}, by ${result.author}.`)
      return result
    })
  })
  ipc.handle('github:draft-pr-field', async (_event, input): Promise<string> => {
    const { taskId, field, title, description } = input
    return withTaskOperation(store, taskId, 'draft', async (check) => {
      const { task, project, baseCommit, headCommit } = requireTask(taskId)
      const diff = await gitDelivery.getDiff(project.path, baseCommit, headCommit)
      check()
      requireTask(taskId)
      return await draftPullRequestField(agentProcesses, task, diff, field, title, description, store.getTaskExecution(taskId)?.reasoningEffort)
    })
  })
  ipc.handle('github:open-pr-url', async (_event, url: string): Promise<void> => {
    await openExternalPullRequest(url)
  })
}
