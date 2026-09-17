import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import type { ProjectGitStatus, ProjectBranches } from '../../shared/types'
import type { GitContext } from './types'
import { git } from './command'

export async function repositoryRoot(projectPath: string): Promise<string> {
  const result = await git(projectPath, ['rev-parse', '--show-toplevel'])
  return realpath(result.stdout.trim())
}

export async function commonGitDirectory(projectPath: string): Promise<string> {
  const result = await git(projectPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return realpath(result.stdout.trim())
}

/**
 * Resolves whether a project folder is inside a Git work tree. Never throws:
 * a folder without Git, or a machine without the `git` binary, has to keep
 * working with the Git flow skipped rather than failing the task.
 */
export async function status(projectPath: string): Promise<ProjectGitStatus> {
  const pathExists = existsSync(projectPath)
  if (!pathExists) {
    return { isRepository: false, repoRoot: null, gitAvailable: true, pathExists }
  }

  try {
    const result = await git(projectPath, ['rev-parse', '--show-toplevel'], [0, 128, 129])
    const repoRoot = result.stdout.trim()
    if (result.exitCode !== 0 || !repoRoot) {
      return { isRepository: false, repoRoot: null, gitAvailable: true, pathExists }
    }
    return { isRepository: true, repoRoot, gitAvailable: true, pathExists }
  } catch {
    // The folder is there, so the failure is the `git` binary itself.
    return { isRepository: false, repoRoot: null, gitAvailable: false, pathExists }
  }
}

/** Runs `git init` in the project folder and reports the resulting status. */
export async function init(projectPath: string): Promise<ProjectGitStatus> {
  await git(projectPath, ['init'])
  return status(projectPath)
}

export async function branches(projectPath: string): Promise<ProjectBranches> {
  const [current, localBranches, remoteBranches, originHead] = await Promise.all([
    git(projectPath, ['branch', '--show-current']),
    git(projectPath, ['for-each-ref', '--sort=refname', '--format=%(refname)%09%(refname:strip=2)%09%(worktreepath)', 'refs/heads/']),
    git(projectPath, ['for-each-ref', '--sort=refname', '--format=%(refname)%09%(refname:strip=2)%09%(symref)', 'refs/remotes/']),
    git(projectPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], [0, 1, 128])
  ])
  const local = localBranches.stdout.split('\n').filter(Boolean).map((line) => {
    const [ref, name, worktreePath] = line.split('\t')
    return { ref, name, worktreePath }
  })
  const remote = remoteBranches.stdout.split('\n').filter(Boolean).flatMap((line) => {
    const [ref, name, symbolicTarget] = line.split('\t')
    return symbolicTarget ? [] : [{ ref, name }]
  })
  const worktreeBases = [
    ...local.map(({ name, ref }) => ({ name, ref, remote: false })),
    ...remote.map(({ name, ref }) => ({ name, ref, remote: true }))
  ]
  const currentBranch = current.stdout.trim() || null
  const originDefaultRef = originHead.stdout.trim()
  const defaultWorktreeBase = worktreeBases.find((candidate) => candidate.ref === originDefaultRef)
    ?? worktreeBases.find((candidate) => candidate.ref === 'refs/remotes/origin/main')
    ?? worktreeBases.find((candidate) => !candidate.remote && candidate.name === currentBranch)
    ?? worktreeBases[0]
    ?? null
  return {
    currentBranch,
    branches: local.map(({ name, worktreePath }) => ({ name, checkedOut: Boolean(worktreePath) })),
    worktreeBases,
    defaultWorktreeBase
  }
}

export async function resolveWorktreeBase(projectPath: string, requested: string): Promise<{ commit: string; branch: string }> {
  const metadata = await branches(projectPath)
  const exactRef = metadata.worktreeBases?.find((candidate) => candidate.ref === requested)
  const named = metadata.worktreeBases?.filter((candidate) => candidate.name === requested) ?? []
  const selected = exactRef ?? (named.length === 1 ? named[0] : undefined)
  if (!selected) {
    if (named.length > 1) throw new Error(`Worktree base ${requested} is ambiguous. Select its full ref.`)
    throw new Error(`Worktree base ${requested} is no longer available`)
  }
  const commit = (await git(projectPath, ['rev-parse', '--verify', `${selected.ref}^{commit}`])).stdout.trim()
  return { commit, branch: selected.name }
}

export async function switchProjectBranch(
  context: GitContext,
  projectPath: string,
  branchName: string
): Promise<ProjectBranches> {
  return withRepoLock(context, projectPath, async () => {
    await git(projectPath, ['check-ref-format', `refs/heads/${branchName}`])
    await git(projectPath, ['show-ref', '--verify', `refs/heads/${branchName}`])
    // Never guess a remote branch or force away local changes.
    await git(projectPath, ['switch', '--no-guess', '--', branchName])
    return branches(projectPath)
  })
}

export async function createProjectBranch(
  context: GitContext,
  projectPath: string,
  branchName: string
): Promise<ProjectBranches> {
  return withRepoLock(context, projectPath, async () => {
    await git(projectPath, ['check-ref-format', '--branch', branchName])
    const existing = await git(projectPath, ['show-ref', '--verify', `refs/heads/${branchName}`], [0, 1, 128])
    if (existing.exitCode === 0) throw new Error(`Branch ${branchName} already exists`)
    await git(projectPath, ['checkout', '-b', branchName])
    return branches(projectPath)
  })
}

export async function stackBase(projectPath: string, branch?: string): Promise<{ commit: string; branch: string }> {
  const ref = branch ? `refs/heads/${branch}` : 'HEAD'
  const commit = (await git(projectPath, ['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim()
  return { commit, branch: branch ?? ((await git(projectPath, ['branch', '--show-current'])).stdout.trim() || commit) }
}

export async function commonBase(projectPath: string, first: string, second: string): Promise<string> {
  return (await git(projectPath, ['merge-base', first, second])).stdout.trim()
}

export async function withRepoLock<T>(context: GitContext, repoRoot: string, action: () => Promise<T>): Promise<T> {
  // Linked worktrees, subdirectories and symlink aliases share the common Git directory.
  const lockKey = await commonGitDirectory(repoRoot)
  const previous = context.repoLocks.get(lockKey) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock
  })
  const queued = previous.then(() => current)
  context.repoLocks.set(lockKey, queued)
  await previous

  try {
    return await action()
  } finally {
    release()
    if (context.repoLocks.get(lockKey) === queued) {
      context.repoLocks.delete(lockKey)
    }
  }
}
