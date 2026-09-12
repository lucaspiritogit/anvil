import { git } from './command'
import type {
  GitContext,
  PreparedCheckout,
  RebasedBranch,
  FinalizeOptions,
  FinalizedCheckout,
  IssueDiffSource
} from './types'
import type {
  ProjectGitStatus,
  ProjectBranches,
  PullRequestGitPreview,
  RebaseStep,
  TaskDiff,
  TaskMergePreview
} from '../../shared/types'
import { status, init, branches, switchProjectBranch, stackBase, commonBase, withRepoLock } from './repository'
import { releaseWorktree, prepareBranch, checkoutBranch, worktreeHead } from './worktrees'
import { renameTaskBranch, restackBranch, finalizeBranch } from './task-branches'
import { rebase } from './rebase'
import { getPullRequestPreview, pushPullRequestBranch } from './pull-requests'
import { getMergePreview, merge } from './merge'
import { changedFiles, getDiff, getIssueDiff } from './diff'

export type { PreparedCheckout, RebasedBranch, FinalizeOptions, FinalizedCheckout, IssueDiffSource } from './types'

export class GitDeliveryManager {
  private readonly context: GitContext

  constructor(worktreesRoot: GitContext['worktreesRoot'], remoteGit: typeof git = git) {
    this.context = { worktreesRoot, remoteGit, repoLocks: new Map() }
  }

  status(projectPath: string): Promise<ProjectGitStatus> {
    return status(projectPath)
  }

  init(projectPath: string): Promise<ProjectGitStatus> {
    return init(projectPath)
  }

  branches(projectPath: string): Promise<ProjectBranches> {
    return branches(projectPath)
  }

  switchProjectBranch(projectPath: string, branchName: string): Promise<ProjectBranches> {
    return switchProjectBranch(this.context, projectPath, branchName)
  }

  releaseWorktree(taskId: string): Promise<void> {
    return releaseWorktree(this.context, taskId)
  }

  prepareBranch(
    projectPath: string,
    taskId: string,
    check: () => void = () => {},
    base?: { commit: string; branch: string }
  ): Promise<PreparedCheckout> {
    return prepareBranch(this.context, projectPath, taskId, check, base)
  }

  checkoutBranch(
    projectPath: string,
    taskId: string,
    branchName: string,
    baseBranch?: string,
    check: () => void = () => {}
  ): Promise<PreparedCheckout> {
    return checkoutBranch(this.context, projectPath, taskId, branchName, baseBranch, check)
  }

  stackBase(projectPath: string, branch?: string): Promise<{ commit: string; branch: string }> {
    return stackBase(projectPath, branch)
  }

  renameTaskBranch(
    projectPath: string,
    taskId: string,
    branchName: string,
    proposedName: string,
    check: () => void = () => {},
    save?: (name: string) => void
  ): Promise<string> {
    return renameTaskBranch(this.context, projectPath, taskId, branchName, proposedName, check, save)
  }

  commonBase(projectPath: string, first: string, second: string): Promise<string> {
    return commonBase(projectPath, first, second)
  }

  changedFiles(projectPath: string, base: string, branch: string): Promise<string[]> {
    return changedFiles(projectPath, base, branch)
  }

  restackBranch(
    projectPath: string,
    taskId: string,
    branch: string,
    oldBase: string,
    target: { commit: string; branch: string },
    check: () => void,
    save?: (result: FinalizedCheckout) => void
  ): Promise<FinalizedCheckout> {
    return restackBranch(this.context, projectPath, taskId, branch, oldBase, target, check, save)
  }

  finalizeBranch(
    projectPath: string,
    taskId: string,
    branchName: string,
    _baseBranch: string | undefined,
    baseCommit: string,
    title: string,
    options: FinalizeOptions = {}
  ): Promise<FinalizedCheckout> {
    return finalizeBranch(this.context, projectPath, taskId, branchName, _baseBranch, baseCommit, title, options)
  }

  withRepoLock<T>(repoRoot: string, action: () => Promise<T>): Promise<T> {
    return withRepoLock(this.context, repoRoot, action)
  }

  rebase(
    projectPath: string,
    taskId: string,
    branchName: string,
    baseCommit: string,
    steps: RebaseStep[],
    check: () => void = () => {}
  ): Promise<RebasedBranch> {
    return rebase(this.context, projectPath, taskId, branchName, baseCommit, steps, check)
  }

  getPullRequestPreview(projectPath: string, branchName: string): Promise<PullRequestGitPreview> {
    return getPullRequestPreview(this.context, projectPath, branchName)
  }

  pushPullRequestBranch(
    projectPath: string,
    expected: PullRequestGitPreview,
    check: () => void = () => {}
  ): Promise<void> {
    return pushPullRequestBranch(this.context, projectPath, expected, check)
  }

  getMergePreview(projectPath: string, branchName: string): Promise<TaskMergePreview> {
    return getMergePreview(projectPath, branchName)
  }

  merge(
    projectPath: string,
    branchName: string,
    expected: TaskMergePreview,
    check: () => void = () => {}
  ): Promise<void> {
    return merge(this.context, projectPath, branchName, expected, check)
  }

  getDiff(repoPath: string, baseCommit: string, headCommit: string): Promise<TaskDiff> {
    return getDiff(repoPath, baseCommit, headCommit)
  }

  worktreeHead(taskId: string): string | null {
    return worktreeHead(this.context, taskId)
  }

  getIssueDiff(repoPath: string, source: IssueDiffSource): Promise<TaskDiff | null> {
    return getIssueDiff(repoPath, source)
  }
}
