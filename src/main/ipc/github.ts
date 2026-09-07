import { ipcMain, shell } from 'electron'
import type { GitHubCredentialStatus, PullRequestField, PullRequestInfo, PullRequestPreview } from '../../shared/types'
import { draftPullRequestField } from '../agents/pull-request-draft'
import { GitHubClient } from '../github-client'
import type { GitHubCredentials } from '../github-credentials'
import { GitHubPullRequests } from '../github-pull-requests'
import { isGitHubPullRequestUrl } from '../github-repository'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'

interface GitHubHandlerDependencies extends TaskContext {
  credentials: GitHubCredentials
  client?: GitHubClient
  recordSystemEvent: RecordSystemEvent
  requireFinishedTask: TaskExecution['requireFinishedTask']
}

export function registerGitHubHandlers({
  store, gitDelivery, agentProcesses, credentials, recordSystemEvent, requireFinishedTask, client = new GitHubClient()
}: GitHubHandlerDependencies): void {
  const pullRequests = new GitHubPullRequests(gitDelivery, credentials, client)
  const opening = new Set<string>()
  const drafting = new Set<string>()
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

  ipcMain.handle('github:credential-status', (): Promise<GitHubCredentialStatus> => credentials.status())
  ipcMain.handle('github:set-token', async (_event, value: string): Promise<GitHubCredentialStatus> => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 1024 || /\s/.test(value.trim())) throw new Error('Enter a valid personal GitHub token.')
    const token = value.trim()
    await client.account(token)
    return credentials.setToken(token)
  })
  ipcMain.handle('github:remove-token', (): Promise<GitHubCredentialStatus> => credentials.removeToken())
  ipcMain.handle('github:pr-preview', async (_event, taskId: string): Promise<PullRequestPreview> => {
    const { project, branchName } = requireTask(taskId)
    return pullRequests.preview(project.path, branchName)
  })
  ipcMain.handle('github:open-pr', async (_event, input: {
    taskId: string; preview: PullRequestPreview; title: string; description: string
  }): Promise<PullRequestInfo> => {
    const { taskId, preview, title, description } = input
    if (typeof title !== 'string' || typeof description !== 'string') throw new Error('Enter a PR title and description.')
    if (opening.has(taskId)) throw new Error('A PR is already being opened for this task.')
    const { project, branchName } = requireTask(taskId)
    opening.add(taskId)
    try {
      const result = await pullRequests.open(project.path, branchName, preview, title, description)
      recordSystemEvent(taskId, `${result.existing ? 'Existing' : 'Opened'} PR #${result.number}: ${result.title}\n${result.url}\n${result.sourceBranch} into ${result.targetBranch}, by ${result.author}.`)
      return result
    } finally {
      opening.delete(taskId)
    }
  })
  ipcMain.handle('github:draft-pr-field', async (_event, input: {
    taskId: string; field: PullRequestField; title: string; description: string
  }): Promise<string> => {
    const { taskId, field, title, description } = input
    if (!['title', 'description'].includes(field) || typeof title !== 'string' || typeof description !== 'string') throw new Error('Choose a PR field to draft.')
    if (drafting.has(taskId)) throw new Error('The agent is already drafting PR text.')
    const { task, project, baseCommit, headCommit } = requireTask(taskId)
    drafting.add(taskId)
    try {
      const diff = await gitDelivery.getDiff(project.path, baseCommit, headCommit)
      return await draftPullRequestField(agentProcesses, task, diff, field, title, description, store.getTaskExecution(taskId)?.reasoningEffort)
    } finally {
      drafting.delete(taskId)
    }
  })
  ipcMain.handle('github:open-pr-url', async (_event, url: string): Promise<void> => {
    if (typeof url !== 'string' || !isGitHubPullRequestUrl(url)) throw new Error('Invalid GitHub PR URL.')
    await shell.openExternal(url)
  })
}
