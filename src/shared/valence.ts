/** Local Valence API contract. Storage sequence keys are internal to SQLite. */
export interface ParentIssue {
  id: string
  anvilTaskId: string
  title: string
  description: string
}

export interface CreateParentIssue {
  anvilTaskId: string
  title: string
  description?: string
}

/** Task ownership cannot be changed by an ordinary parent update. */
export type UpdateParentIssue = Partial<Pick<CreateParentIssue, 'title' | 'description'>>

export interface Issue {
  id: string
  parentId: string
  title: string
  description: string
  checklist: string[]
  validation: string
  labels: string[]
  priority: 'urgent' | 'high' | 'medium' | 'low'
  dependencies: string[]
  status: 'queued' | 'working' | 'blocked' | 'review' | 'complete'
  evidence?: string
  completedAt?: number
  reviewedAt?: number
  /** Task worktree commit range captured for the per-issue review diff. */
  baseCommit?: string
  headCommit?: string
}

export interface CreateIssue {
  parentId: string
  title: string
  description: string
  checklist: string[]
  validation: string
  labels?: string[]
  priority?: Issue['priority']
  dependencies?: string[]
}

export type UpdateIssue = Partial<CreateIssue>

/** Keys identify entries in a batch and are not persisted. */
export interface BatchIssue extends CreateIssue {
  key: string
}

export type IssueSelection =
  | { ids: string[]; parentId?: string }
  | { parentId: string; ids?: string[] }

export interface Completion {
  checklist: boolean[]
  evidence: string
}
