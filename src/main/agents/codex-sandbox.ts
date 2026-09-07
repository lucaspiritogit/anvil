import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname } from 'node:path'
import { openTracker } from 'valence'
import type { CodexSandboxPolicy } from './codex-app-server-protocol'

const execFileAsync = promisify(execFile)

/** Grant task files, Git metadata and the tracker directory, not the source checkout. */
export async function codexSandboxPolicy(cwd: string, projectPath?: string): Promise<CodexSandboxPolicy> {
  const writableRoots = new Set([await realpath(cwd)])
  if (projectPath) {
    const tracker = openTracker(projectPath)
    try {
      // SQLite also needs to write WAL/SHM files beside the database.
      writableRoots.add(await realpath(dirname(tracker.databasePath)))
    } finally {
      tracker.close()
    }
  }
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'
    ], { encoding: 'utf8', windowsHide: true })
    for (const path of stdout.trim().split(/\r?\n/)) writableRoots.add(await realpath(path))
  } catch (error) {
    // Non-Git projects still run in their own cwd. Other failures must not
    // silently omit the permissions needed to commit in a linked worktree.
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code !== 'ENOENT' && !failure.stderr?.includes('not a git repository')) throw error
  }
  return {
    type: 'workspaceWrite', writableRoots: [...writableRoots], networkAccess: true,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false
  }
}
