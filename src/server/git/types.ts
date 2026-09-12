import type { TaskCommit } from '../../shared/types'
import type { git } from './command'

export interface GitContext {
  worktreesRoot: string | ((taskId: string) => string)
  repoLocks: Map<string, Promise<void>>
  remoteGit: typeof git
}

export interface PreparedCheckout {
  baseBranch: string
  branchName: string
  baseCommit: string
  cwd: string
  initializedRepository: boolean
}

export interface RebasedBranch {
  headCommit: string
  commits: TaskCommit[]
  filesChanged: number
  additions: number
  deletions: number
}

export interface FinalizeOptions {
  onFinisherCommand?: (command: string) => void
  check?: () => void
}

export interface FinalizedCheckout {
  headCommit: string
  branchName?: string
  hasChanges: boolean
  finisherCommitted: boolean
  filesChanged: number
  additions: number
  deletions: number
}

export interface IssueDiffSource {
  /** Commits recorded for the issue itself, captured at claim and turn finalization. */
  baseCommit?: string | null
  headCommit?: string | null
  /** Whole-task range; the fallback for legacy issues without a recorded range. */
  taskBaseCommit?: string | null
  taskHeadCommit?: string | null
}
