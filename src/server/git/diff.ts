import type { TaskCommit, TaskDiff } from '../../shared/types'
import type { IssueDiffSource } from './types'
import { git } from './command'

export async function changedFiles(projectPath: string, base: string, branch: string): Promise<string[]> {
  return (await git(projectPath, ['diff', '--name-only', '-z', `${base}..refs/heads/${branch}`])).stdout.split('\0').filter(Boolean)
}

export async function getDiff(repoPath: string, baseCommit: string, headCommit: string): Promise<TaskDiff> {
  const [patch, log] = await Promise.all([
    git(repoPath, ['diff', '--find-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', baseCommit, headCommit, '--']),
    git(repoPath, ['log', '--format=%H%x09%s', `${baseCommit}..${headCommit}`])
  ])
  const commits: TaskCommit[] = log.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const split = line.indexOf('\t')
      return { sha: line.slice(0, split), subject: line.slice(split + 1) }
    })
  return { patch: patch.stdout, commits }
}

/** Review diff for one issue; issues without a recorded range fall back to the whole task diff. */
export async function getIssueDiff(repoPath: string, source: IssueDiffSource): Promise<TaskDiff | null> {
  if (source.baseCommit && source.headCommit) {
    return getDiff(repoPath, source.baseCommit, source.headCommit)
  }
  if (!source.baseCommit && !source.headCommit && source.taskBaseCommit && source.taskHeadCommit) {
    return getDiff(repoPath, source.taskBaseCommit, source.taskHeadCommit)
  }
  return null
}
