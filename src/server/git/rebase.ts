import type { RebaseStep } from '../../shared/types'
import type { GitContext, RebasedBranch } from './types'
import { git } from './command'
import { withRepoLock } from './repository'
import { createRebaseWorktree } from './worktrees'
import { getDiff } from './diff'
import { parseNumstat } from './commits'

interface RebaseGroup {
  message: string
  shas: string[]
}

/** A leading squash starts a commit; later squashes join the preceding group. */
function planGroups(steps: RebaseStep[]): RebaseGroup[] {
  const groups: RebaseGroup[] = []
  for (const step of steps) {
    if (step.action === 'drop') {
      continue
    }
    const current = groups[groups.length - 1]
    if (step.action === 'squash' && current) {
      current.shas.push(step.sha)
      continue
    }
    groups.push({ message: step.message.trim() || 'Rebased commit', shas: [step.sha] })
  }
  return groups
}

/**
 * Replays a task's commits according to a plan, the way `git rebase -i` does:
 * a `pick` starts a commit, a following `squash` folds into it, and a `drop`
 * is left out. Anvil runs this itself rather than asking git for an
 * interactive session, so there is no editor to drive and the outcome is
 * exactly what the plan said.
 *
 * The branch is reset to its base and the kept commits are re-applied with
 * `cherry-pick --no-commit`. Nothing is lost if that fails part-way: the
 * original tip is recorded first and restored before the error is raised.
 */
export async function rebase(
  context: GitContext,
  projectPath: string,
  taskId: string,
  branchName: string,
  baseCommit: string,
  steps: RebaseStep[],
  check: () => void = () => {}
): Promise<RebasedBranch> {
  const groups = planGroups(steps)
  if (!groups.length) {
    throw new Error('A rebase has to keep at least one commit')
  }

  return withRepoLock(context, projectPath, async () => {
    check()
    const worktree = await createRebaseWorktree(context, projectPath, taskId, branchName, check)
    const originalTip = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim()

    // The plan was built from a commit list that may since have moved.
    const actual = (await git(worktree, ['rev-list', '--reverse', `${baseCommit}..HEAD`])).stdout
      .split(/\r?\n/)
      .filter(Boolean)
    const planned = steps.map((step) => step.sha)
    if (actual.length !== planned.length || actual.some((sha, i) => sha !== planned[i])) {
      throw new Error('This branch changed since the commit list was loaded. Reopen it and retry.')
    }

    try {
      check()
      await git(worktree, ['reset', '--hard', baseCommit])
      for (const group of groups) {
        for (const sha of group.shas) {
          check()
          await git(worktree, ['cherry-pick', '--no-commit', sha])
        }
        // A group whose changes cancel out leaves nothing staged; git drops such
        // a commit during a real rebase, so this does too.
        const staged = await git(worktree, ['diff', '--cached', '--quiet'], [0, 1])
        if (staged.exitCode === 0) {
          continue
        }
        check()
        await git(worktree, ['commit', '-m', group.message])
      }
    } catch (error) {
      await git(worktree, ['cherry-pick', '--abort'], [0, 1, 128])
      await git(worktree, ['reset', '--hard', originalTip], [0, 1, 128])
      throw new Error(
        `Rebase failed and the branch was left untouched: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    const headCommit = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim()
    const numstat = await git(worktree, ['diff', '--numstat', baseCommit, headCommit, '--'])
    const stats = parseNumstat(numstat.stdout)

    const { commits } = await getDiff(projectPath, baseCommit, headCommit)
    return { headCommit, commits, ...stats }
  })
}
