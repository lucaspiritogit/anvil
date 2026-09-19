import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MERGE_CONFLICT_MAX_FILE_BYTES, type TaskMergeConflict, type TaskMergeConflictFile, type TaskMergeConflictFileStatus, type TaskMergeConflictSnapshot, type TaskMergePreview, type TaskPushPreview } from '@anvil/protocol/types'
import type { GitContext, MergeConflictResult, MergeResult } from './types'
import { git } from './command'
import { withRepoLock, repositoryRoot } from './repository'

export async function getMergePreview(projectPath: string, branchName: string): Promise<TaskMergePreview> {
  await git(projectPath, ['check-ref-format', `refs/heads/${branchName}`])
  const targetBranch = (await git(projectPath, ['branch', '--show-current'])).stdout.trim()
  if (!targetBranch) {
    throw new Error('Check out a branch in the project before merging this task.')
  }
  if (targetBranch === branchName) {
    throw new Error('The task branch is checked out in the project. Check out the destination branch first.')
  }

  const sourceCommit = (await git(projectPath, ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`])).stdout.trim()
  const targetCommit = (await git(projectPath, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
  const commitCount = Number((await git(projectPath, ['rev-list', '--count', `${targetCommit}..${sourceCommit}`])).stdout.trim())
  return { sourceBranch: branchName, targetBranch, sourceCommit, targetCommit, commitCount }
}

/** Merge only the branch tips the user confirmed, without switching their checkout. */
export async function merge(
  context: GitContext,
  projectPath: string,
  branchName: string,
  expected: TaskMergePreview,
  check: () => void = () => {}
): Promise<MergeResult> {
  const repoRoot = await repositoryRoot(projectPath)
  return withRepoLock(context, repoRoot, async () => {
    const current = await getMergePreview(repoRoot, branchName)
    if (!expected || current.sourceBranch !== expected.sourceBranch || current.targetBranch !== expected.targetBranch ||
      current.sourceCommit !== expected.sourceCommit || current.targetCommit !== expected.targetCommit ||
      current.commitCount !== expected.commitCount) {
      throw new Error('The branches changed since the merge preview was loaded. Close this dialog and merge again.')
    }

    for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
      const operationPath = (await git(repoRoot, ['rev-parse', '--git-path', operation])).stdout.trim()
      if (existsSync(isAbsolute(operationPath) ? operationPath : join(repoRoot, operationPath))) {
        throw new Error('Finish or abort the existing Git operation before merging this task.')
      }
    }
    const dirty = (await git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()
    if (dirty) {
      throw new Error('Commit or stash local changes in the project before merging this task.')
    }

    check()
    try {
      await git(repoRoot, ['-c', 'merge.autoStash=false', 'merge', '--no-edit', '--commit', '--no-squash', '--no-autostash', `refs/heads/${branchName}`])
    } catch (error) {
      const mergeHead = await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [0, 1])
      if (mergeHead.exitCode === 0) {
        let conflict: MergeConflictResult | undefined
        try {
          const conflictedFiles = (await git(repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout
            .split('\0').filter(Boolean)
          const head = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
          if (conflictedFiles.length > 0 && mergeHead.stdout.trim() === expected.sourceCommit && head === expected.targetCommit) {
            conflict = {
              status: 'conflicted',
              repositoryRoot: repoRoot,
              mergeHeadCommit: mergeHead.stdout.trim(),
              conflictedFiles
            }
          }
        } catch {}
        if (conflict) {
          return conflict
        }
        try {
          await git(repoRoot, ['merge', '--abort'])
        } catch (abortError) {
          throw new Error(`Merge failed: ${error instanceof Error ? error.message : String(error)}. Could not abort the merge: ${abortError instanceof Error ? abortError.message : String(abortError)}`)
        }
      }
      throw new Error(`Merge failed. The task was not merged: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { status: 'merged', commit: (await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim() }
  })
}

export async function validateMergeConflict(
  projectPath: string,
  expected: Pick<TaskMergeConflict, 'repositoryRoot' | 'sourceBranch' | 'targetBranch' | 'sourceCommit' | 'targetCommit' | 'mergeHeadCommit' | 'conflictedFiles'>
): Promise<string[]> {
  const repoRoot = await repositoryRoot(projectPath)
  return (await validateMergeConflictState(repoRoot, expected)).map((entry) => entry.path)
}

interface UnmergedEntry {
  path: string
  stages: (1 | 2 | 3)[]
  modes: string[]
}

async function unmergedEntries(repoRoot: string): Promise<UnmergedEntry[]> {
  const records = (await git(repoRoot, ['ls-files', '--unmerged', '-z'])).stdout.split('\0').filter(Boolean)
  const entries = new Map<string, { stages: Set<1 | 2 | 3>; modes: Set<string> }>()
  for (const record of records) {
    const separator = record.indexOf('\t')
    const metadata = separator >= 0 ? record.slice(0, separator) : ''
    const path = separator >= 0 ? record.slice(separator + 1) : ''
    const [mode, , stageText] = metadata.split(' ')
    const stage = Number(stageText)
    if (!path || !mode || (stage !== 1 && stage !== 2 && stage !== 3)) {
      throw new Error('Git reported an unsupported unmerged index entry.')
    }
    const entry = entries.get(path) ?? { stages: new Set<1 | 2 | 3>(), modes: new Set<string>() }
    entry.stages.add(stage)
    entry.modes.add(mode)
    entries.set(path, entry)
  }
  return [...entries].map(([path, entry]) => ({
    path,
    stages: [...entry.stages].sort() as (1 | 2 | 3)[],
    modes: [...entry.modes].sort()
  })).sort((first, second) => first.path.localeCompare(second.path))
}

async function validateMergeConflictState(
  repoRoot: string,
  expected: Pick<TaskMergeConflict, 'repositoryRoot' | 'sourceBranch' | 'targetBranch' | 'sourceCommit' | 'targetCommit' | 'mergeHeadCommit' | 'conflictedFiles'>
): Promise<UnmergedEntry[]> {
  if (repoRoot !== expected.repositoryRoot) throw new Error('The merge conflict belongs to a different repository checkout.')
  const [branch, head, source, mergeHead, unmerged] = await Promise.all([
    git(repoRoot, ['branch', '--show-current']),
    git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(repoRoot, ['rev-parse', '--verify', `refs/heads/${expected.sourceBranch}^{commit}`]),
    git(repoRoot, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [0, 1]),
    unmergedEntries(repoRoot)
  ])
  const originalPaths = new Set(expected.conflictedFiles)
  if (branch.stdout.trim() !== expected.targetBranch || head.stdout.trim() !== expected.targetCommit ||
      source.stdout.trim() !== expected.sourceCommit || mergeHead.exitCode !== 0 ||
      mergeHead.stdout.trim() !== expected.mergeHeadCommit || expected.mergeHeadCommit !== expected.sourceCommit ||
      unmerged.some((entry) => !originalPaths.has(entry.path))) {
    throw new Error('The paused merge no longer matches this task. Inspect the repository before continuing.')
  }
  return unmerged
}

function conflictStatus(stages: readonly number[]): TaskMergeConflictFileStatus {
  switch (stages.join('')) {
    case '1': return 'both_deleted'
    case '2': return 'added_by_us'
    case '3': return 'added_by_them'
    case '12': return 'deleted_by_them'
    case '13': return 'deleted_by_us'
    case '23': return 'both_added'
    case '123': return 'both_modified'
    default: return 'unsupported'
  }
}

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

async function conflictPath(repoRoot: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Git reported an unsafe unmerged path.')
  }
  const candidate = resolve(repoRoot, path)
  if (!pathInside(repoRoot, candidate)) throw new Error('Git reported an unsafe unmerged path.')
  let existing = dirname(candidate)
  while (pathInside(repoRoot, existing)) {
    try {
      const resolvedParent = await realpath(existing)
      if (!pathInside(repoRoot, resolvedParent)) throw new Error('The conflicted file escapes the repository through a symbolic link.')
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) break
      existing = parent
    }
  }
  throw new Error('The conflicted file is outside the repository checkout.')
}

function unsupportedFile(entry: UnmergedEntry, reason: Extract<TaskMergeConflictFile, { support: 'unsupported' }>['reason']): TaskMergeConflictFile {
  return { path: entry.path, status: conflictStatus(entry.stages), stages: entry.stages, support: 'unsupported', reason }
}

async function conflictFile(repoRoot: string, entry: UnmergedEntry): Promise<TaskMergeConflictFile> {
  if (/[\x00-\x1f\x7f]/.test(entry.path)) return unsupportedFile(entry, 'unsafe_path')
  const path = await conflictPath(repoRoot, entry.path)
  const status = conflictStatus(entry.stages)
  if (status === 'unsupported') return unsupportedFile(entry, 'unsupported_status')
  if (entry.modes.includes('160000')) return unsupportedFile(entry, 'submodule')
  if (entry.modes.includes('120000')) return unsupportedFile(entry, 'symlink')
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unsupportedFile(entry, 'missing')
    throw error
  }
  if (metadata.isSymbolicLink()) return unsupportedFile(entry, 'symlink')
  if (!metadata.isFile()) return unsupportedFile(entry, 'other')
  if (metadata.size > MERGE_CONFLICT_MAX_FILE_BYTES) return unsupportedFile(entry, 'oversized')
  const bytes = await readFile(path)
  if (bytes.length > MERGE_CONFLICT_MAX_FILE_BYTES) return unsupportedFile(entry, 'oversized')
  if (bytes.includes(0)) return unsupportedFile(entry, 'binary')
  let contents: string
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return unsupportedFile(entry, 'binary')
  }
  return {
    path: entry.path,
    status,
    stages: entry.stages,
    support: 'text',
    contents,
    contentsHash: createHash('sha256').update(bytes).digest('hex')
  }
}

async function mergeConflictSnapshot(
  repoRoot: string,
  conflict: TaskMergeConflict,
  entries: UnmergedEntry[]
): Promise<TaskMergeConflictSnapshot> {
  const files = await Promise.all(entries.map((entry) => conflictFile(repoRoot, entry)))
  return {
    id: conflict.id,
    taskId: conflict.taskId,
    sourceBranch: conflict.sourceBranch,
    targetBranch: conflict.targetBranch,
    requestedAction: conflict.requestedAction,
    files,
    canComplete: files.length === 0
  }
}

export async function getMergeConflict(
  context: GitContext,
  projectPath: string,
  conflict: TaskMergeConflict
): Promise<TaskMergeConflictSnapshot> {
  const repoRoot = await repositoryRoot(projectPath)
  return withRepoLock(context, repoRoot, async () => {
    const entries = await validateMergeConflictState(repoRoot, conflict)
    return mergeConflictSnapshot(repoRoot, conflict, entries)
  })
}

function hasConflictMarkers(contents: string): boolean {
  return /^(?:<{7,}(?: |$)|\|{7,}(?: |$)|={7,}\s*$|>{7,}(?: |$))/m.test(contents)
}

export async function saveMergeConflictFile(
  context: GitContext,
  projectPath: string,
  conflict: TaskMergeConflict,
  path: string,
  contents: string,
  expectedContentsHash: string,
  check: () => void = () => {}
): Promise<TaskMergeConflictSnapshot> {
  if (Buffer.byteLength(contents) > MERGE_CONFLICT_MAX_FILE_BYTES) throw new Error('The resolved file is too large to save.')
  const repoRoot = await repositoryRoot(projectPath)
  return withRepoLock(context, repoRoot, async () => {
    const entries = await validateMergeConflictState(repoRoot, conflict)
    const entry = entries.find((candidate) => candidate.path === path)
    if (!entry) throw new Error('This file is no longer unmerged. Refresh the conflict details.')
    const current = await conflictFile(repoRoot, entry)
    if (current.support !== 'text') throw new Error(`This conflicted file cannot be edited as text (${current.reason}).`)
    if (current.contentsHash !== expectedContentsHash) throw new Error('The conflicted file changed after it was loaded. Refresh it before saving.')
    check()
    const target = await conflictPath(repoRoot, path)
    const mode = (await lstat(target)).mode & 0o777
    const temporary = join(dirname(target), `.anvil-merge-resolution-${randomUUID()}`)
    try {
      await writeFile(temporary, contents, { flag: 'wx', mode })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
    if (!hasConflictMarkers(contents)) await git(repoRoot, ['add', '--', path])
    const refreshed = await unmergedEntries(repoRoot)
    return mergeConflictSnapshot(repoRoot, conflict, refreshed)
  })
}

export async function completeMergeConflict(
  context: GitContext,
  projectPath: string,
  conflict: TaskMergeConflict,
  check: () => void = () => {}
): Promise<string> {
  const repoRoot = await repositoryRoot(projectPath)
  return withRepoLock(context, repoRoot, async () => {
    if (repoRoot !== conflict.repositoryRoot) throw new Error('The merge conflict belongs to a different repository checkout.')
    const mergeInProgress = await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [0, 1])
    if (mergeInProgress.exitCode !== 0) {
      const [branch, source, head, containsTarget, containsSource, status] = await Promise.all([
        git(repoRoot, ['branch', '--show-current']),
        git(repoRoot, ['rev-parse', '--verify', `refs/heads/${conflict.sourceBranch}^{commit}`]),
        git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
        git(repoRoot, ['merge-base', '--is-ancestor', conflict.targetCommit, 'HEAD'], [0, 1]),
        git(repoRoot, ['merge-base', '--is-ancestor', conflict.sourceCommit, 'HEAD'], [0, 1]),
        git(repoRoot, ['status', '--porcelain=v1'])
      ])
      if (branch.stdout.trim() !== conflict.targetBranch || source.stdout.trim() !== conflict.sourceCommit ||
        containsTarget.exitCode !== 0 || containsSource.exitCode !== 0 || status.stdout.trim()) {
        throw new Error('The checkout is not a clean completed merge containing the confirmed source and target commits.')
      }
      check()
      return head.stdout.trim()
    }
    const entries = await validateMergeConflictState(repoRoot, conflict)
    if (entries.length) throw new Error(`Resolve all merge conflicts before completing the merge (${entries.length} remaining).`)
    check()
    await git(repoRoot, ['commit', '--no-edit'])
    const [branch, head, mergeHead, containsTarget, containsSource, status] = await Promise.all([
      git(repoRoot, ['branch', '--show-current']),
      git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
      git(repoRoot, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [0, 1]),
      git(repoRoot, ['merge-base', '--is-ancestor', conflict.targetCommit, 'HEAD'], [0, 1]),
      git(repoRoot, ['merge-base', '--is-ancestor', conflict.sourceCommit, 'HEAD'], [0, 1]),
      git(repoRoot, ['status', '--porcelain=v1'])
    ])
    if (branch.stdout.trim() !== conflict.targetBranch || mergeHead.exitCode === 0 ||
      containsTarget.exitCode !== 0 || containsSource.exitCode !== 0 || status.stdout.trim()) {
      throw new Error('The completed merge does not contain the confirmed source and target commits. Inspect the repository before continuing.')
    }
    return head.stdout.trim()
  })
}

export async function abortMergeConflict(
  context: GitContext,
  projectPath: string,
  conflict: TaskMergeConflict,
  check: () => void = () => {}
): Promise<void> {
  const repoRoot = await repositoryRoot(projectPath)
  return withRepoLock(context, repoRoot, async () => {
    await validateMergeConflictState(repoRoot, conflict)
    check()
    await git(repoRoot, ['merge', '--abort'])
    const [branch, head, mergeHead] = await Promise.all([
      git(repoRoot, ['branch', '--show-current']),
      git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
      git(repoRoot, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [0, 1])
    ])
    if (branch.stdout.trim() !== conflict.targetBranch || head.stdout.trim() !== conflict.targetCommit || mergeHead.exitCode === 0) {
      throw new Error('Git did not restore the confirmed target checkout after aborting the merge.')
    }
  })
}

async function originPushUrl(projectPath: string): Promise<string> {
  let output: string
  try {
    output = (await git(projectPath, ['remote', 'get-url', '--push', '--all', 'origin'])).stdout
  } catch {
    throw new Error('Configure exactly one origin push URL before pushing this branch.')
  }
  const urls = output.trim().split(/\r?\n/).filter(Boolean)
  if (urls.length !== 1) {
    throw new Error('Configure exactly one origin push URL before pushing this branch.')
  }
  return urls[0]
}

function remoteUrlHash(remoteUrl: string): string {
  return createHash('sha256').update(remoteUrl).digest('hex')
}

async function remoteBranchCommit(
  context: GitContext,
  projectPath: string,
  remoteUrl: string,
  targetBranch: string
): Promise<string | null> {
  let result: Awaited<ReturnType<GitContext['remoteGit']>>
  try {
    result = await context.remoteGit(
      projectPath,
      ['ls-remote', '--exit-code', '--refs', '--', remoteUrl, `refs/heads/${targetBranch}`],
      [0, 2],
      { GIT_TERMINAL_PROMPT: '0' }
    )
  } catch (error) {
    throw new Error(`Could not read ${targetBranch} from origin before pushing: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (result.exitCode === 2 || !result.stdout.trim()) return null
  const lines = result.stdout.trim().split(/\r?\n/)
  const [commit, ref, ...extra] = lines[0].trim().split(/\s+/)
  if (lines.length !== 1 || extra.length || ref !== `refs/heads/${targetBranch}` || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(commit)) {
    throw new Error(`Origin returned an ambiguous ${targetBranch} branch. Check the remote before pushing.`)
  }
  return commit
}

/** Snapshot the checked-out target and its configured origin branch without mutating either repository. */
export async function getPushPreview(
  context: GitContext,
  projectPath: string,
  expectedTargetBranch?: string,
  requiredCommit?: string
): Promise<TaskPushPreview> {
  const repoRoot = await repositoryRoot(projectPath)
  const targetBranch = (await git(repoRoot, ['branch', '--show-current'])).stdout.trim()
  if (!targetBranch) throw new Error('Check out a branch in the project before pushing.')
  await git(repoRoot, ['check-ref-format', `refs/heads/${targetBranch}`])
  if (expectedTargetBranch && targetBranch !== expectedTargetBranch) {
    throw new Error(`The checked-out target changed from ${expectedTargetBranch} to ${targetBranch}. Refresh the push details.`)
  }
  const targetCommit = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (requiredCommit) {
    const containsTask = await git(repoRoot, ['merge-base', '--is-ancestor', requiredCommit, targetCommit], [0, 1])
    if (containsTask.exitCode !== 0) {
      throw new Error('Check out the target branch containing this task\'s merged changes before pushing.')
    }
  }
  const remoteUrl = await originPushUrl(repoRoot)
  const remoteTargetCommit = await remoteBranchCommit(context, repoRoot, remoteUrl, targetBranch)
  if (remoteUrlHash(await originPushUrl(repoRoot)) !== remoteUrlHash(remoteUrl)) {
    throw new Error('The origin push URL changed while loading the push details. Refresh and try again.')
  }
  return { targetBranch, targetCommit, remote: 'origin', remoteTargetCommit, remoteUrlHash: remoteUrlHash(remoteUrl) }
}

/** Push only the checked-out branch tip the user confirmed, using a non-force explicit refspec. */
export async function push(
  context: GitContext,
  projectPath: string,
  expected: TaskPushPreview,
  requiredCommit?: string,
  check: () => void = () => {}
): Promise<void> {
  const repoRoot = await repositoryRoot(projectPath)
  await withRepoLock(context, repoRoot, async () => {
    const current = await getPushPreview(context, repoRoot, expected.targetBranch, requiredCommit)
    if (!expected || current.targetBranch !== expected.targetBranch || current.targetCommit !== expected.targetCommit ||
      current.remote !== expected.remote || current.remoteTargetCommit !== expected.remoteTargetCommit ||
      current.remoteUrlHash !== expected.remoteUrlHash) {
      throw new Error('The target branch or origin changed since the push preview was loaded. Refresh and try again.')
    }
    const remoteUrl = await originPushUrl(repoRoot)
    if (remoteUrlHash(remoteUrl) !== expected.remoteUrlHash) {
      throw new Error('The origin push URL changed since the push preview was loaded. Refresh and try again.')
    }
    check()
    try {
      await context.remoteGit(
        repoRoot,
        ['push', '--porcelain', '--', remoteUrl, `${expected.targetCommit}:refs/heads/${expected.targetBranch}`],
        [0],
        { GIT_TERMINAL_PROMPT: '0' }
      )
    } catch (error) {
      throw new Error(`Origin rejected the push to ${expected.targetBranch}. Fetch and reconcile remote changes, then try again: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
