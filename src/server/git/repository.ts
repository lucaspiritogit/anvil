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
  const [current, branches] = await Promise.all([
    git(projectPath, ['branch', '--show-current']),
    git(projectPath, ['for-each-ref', '--sort=refname', '--format=%(refname:strip=2)%09%(worktreepath)', 'refs/heads/'])
  ])
  return {
    currentBranch: current.stdout.trim() || null,
    branches: branches.stdout.split('\n').filter(Boolean).map((line) => {
      const [name, worktreePath] = line.split('\t')
      return { name, checkedOut: Boolean(worktreePath) }
    })
  }
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
