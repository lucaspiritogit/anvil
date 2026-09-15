import type { TaskCommit, TaskDiff } from '../../shared/types'
import type { IssueDiffSource } from './types'
import { git } from './command'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface WorkingTreeDiff extends TaskDiff {
  paths: string[]
  filesChanged: number
  additions: number
  deletions: number
}

function scopedPaths(repoPath: string, paths: string[]): string[] {
  const root = resolve(repoPath)
  return [...new Set(paths.flatMap((path) => {
    if (!path || path.includes('\0')) return []
    const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path)
    const child = relative(root, candidate)
    if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) return []
    return [child.split(sep).join('/')]
  }))]
}

function readNumstat(output: string): { filesChanged: number; additions: number; deletions: number } {
  let filesChanged = 0
  let additions = 0
  let deletions = 0
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    const [added, deleted] = line.split('\t', 2)
    filesChanged++
    if (added !== '-') additions += Number(added)
    if (deleted !== '-') deletions += Number(deleted)
  }
  return { filesChanged, additions, deletions }
}

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

export async function getWorkingTreeDiff(repoPath: string, paths: string[]): Promise<WorkingTreeDiff> {
  const scoped = scopedPaths(repoPath, paths)
  const pathspecs = scoped.map((path) => `./${path}`)
  if (!pathspecs.length) return { patch: '', commits: [], paths: [], filesChanged: 0, additions: 0, deletions: 0 }
  const options = ['--no-color', '--no-ext-diff', '--no-textconv']
  const literalPathspecs = { GIT_LITERAL_PATHSPECS: '1' }
  const [trackedPatch, trackedNumstat, untracked] = await Promise.all([
    git(repoPath, ['diff', ...options, '--', ...pathspecs], [0], literalPathspecs),
    git(repoPath, ['diff', '--numstat', '--', ...pathspecs], [0], literalPathspecs),
    git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs], [0], literalPathspecs)
  ])
  const untrackedPaths = untracked.stdout.split('\0').filter(Boolean)
  const untrackedDiffs = await Promise.all(untrackedPaths.map(async (path) => {
    const pathspec = `./${path}`
    const [patch, numstat] = await Promise.all([
      git(repoPath, ['diff', '--no-index', ...options, '--', '/dev/null', pathspec], [0, 1]),
      git(repoPath, ['diff', '--no-index', '--numstat', '--', '/dev/null', pathspec], [0, 1])
    ])
    return { patch: patch.stdout, stats: readNumstat(numstat.stdout) }
  }))
  const trackedStats = readNumstat(trackedNumstat.stdout)
  return {
    patch: [trackedPatch.stdout, ...untrackedDiffs.map((diff) => diff.patch)].filter(Boolean).join('\n'),
    commits: [],
    paths: scoped,
    filesChanged: trackedStats.filesChanged + untrackedDiffs.reduce((sum, diff) => sum + diff.stats.filesChanged, 0),
    additions: trackedStats.additions + untrackedDiffs.reduce((sum, diff) => sum + diff.stats.additions, 0),
    deletions: trackedStats.deletions + untrackedDiffs.reduce((sum, diff) => sum + diff.stats.deletions, 0)
  }
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
