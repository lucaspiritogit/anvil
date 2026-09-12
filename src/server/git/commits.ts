import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FinalizeOptions, FinalizedCheckout } from './types'
import { git, formatGitCommand } from './command'

export function parseNumstat(output: string): Pick<FinalizedCheckout, 'filesChanged' | 'additions' | 'deletions'> {
  let filesChanged = 0
  let additions = 0
  let deletions = 0
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const [added, deleted] = line.split('\t')
    filesChanged += 1
    if (added !== '-') {
      additions += Number(added) || 0
    }
    if (deleted !== '-') {
      deletions += Number(deleted) || 0
    }
  }
  return { filesChanged, additions, deletions }
}

/** Establish a common ancestor without committing files or changing the user's index. */
export async function createInitialCommit(repoRoot: string, branchRef: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-initial-'))
  const env = { GIT_INDEX_FILE: join(directory, 'index') }
  try {
    await git(repoRoot, ['read-tree', '--empty'], [0], env)
    const tree = (await git(repoRoot, ['write-tree'], [0], env)).stdout.trim()
    const commit = (await git(repoRoot, ['commit-tree', tree, '-m', 'Initial commit'], [0], env)).stdout.trim()
    // Fail if another process initialized this branch in the meantime.
    await git(repoRoot, ['update-ref', branchRef, commit, ''])
    return commit
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function commitCheckout(
  checkoutPath: string,
  baseCommit: string,
  fallbackMessage: string,
  options: FinalizeOptions = {}
): Promise<FinalizedCheckout> {
  const { onFinisherCommand } = options
  const dirty = (await git(checkoutPath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout
  const finisherCommitted = dirty.trim().length > 0
  if (dirty.trim()) {
    // The agent was asked to commit its own work and did not, so Anvil commits
    // the remainder rather than losing it. Each command is reported as it runs.
    for (const args of [['add', '--all'], ['commit', '-m', fallbackMessage]]) {
      options.check?.()
      onFinisherCommand?.(formatGitCommand(args))
      options.check?.()
      await git(checkoutPath, args)
    }
  }

  options.check?.()
  if ((await git(checkoutPath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()) {
    throw new Error('The task worktree still has uncommitted changes after finalization.')
  }
  const headCommit = (await git(checkoutPath, ['rev-parse', 'HEAD'])).stdout.trim()
  // Include the task branch with the final diff.
  const branchName = (await git(checkoutPath, ['branch', '--show-current'])).stdout.trim()
  const numstat = await git(checkoutPath, ['diff', '--numstat', baseCommit, headCommit, '--'])
  const stats = parseNumstat(numstat.stdout)
  const changes = await git(checkoutPath, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', baseCommit, headCommit, '--'], [0, 1])
  options.check?.()
  return {
    headCommit,
    ...(branchName ? { branchName } : {}),
    hasChanges: changes.exitCode === 1,
    finisherCommitted,
    ...stats
  }
}
