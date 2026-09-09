import { execFile, spawn } from 'node:child_process'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Project, ProjectFileList } from '../shared/types'

const execFileAsync = promisify(execFile)

export const PROJECT_FILE_LIMITS = {
  entries: 20_000,
  results: 10_000,
  bytes: 2 * 1024 * 1024,
  depth: 32,
  milliseconds: 5_000
} as const

const excluded = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', '.venv', 'venv',
  '__pycache__', '.pnpm-store', '.yarn', '.next', '.nuxt', '.cache', 'dist', 'out',
  'build', 'coverage', 'target'
])
const gitExclusions = [...excluded].map((name) => `:(glob,icase,exclude)**/${name}/**`)
let activeScans = 0

export function projectFileError(
  projectId: string, code: NonNullable<ProjectFileList['error']>['code'], message: string
): ProjectFileList {
  return { projectId, paths: [], source: null, truncated: false, warnings: [], error: { code, message } }
}

/** Validate without rewriting filenames, including literal backslashes on POSIX. */
export function projectFileParts(path: string): string[] | null {
  if (!path || path.includes('\0') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return null
  if (sep === '\\' && path.includes('\\')) return null
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || excluded.has(part.toLowerCase()))) return null
  return parts
}

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

function gitEnvironment(): NodeJS.ProcessEnv {
  // Inherited Git overrides must not redirect enumeration to another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
}

/** No cache: callers refresh on picker open, explicit refresh and branch checkout. */
export async function listProjectFiles(
  project: Pick<Project, 'id' | 'path'>,
  overrides: Partial<Record<keyof typeof PROJECT_FILE_LIMITS, number>> = {}
): Promise<ProjectFileList> {
  if (activeScans >= 2) return projectFileError(project.id, 'busy', 'File lookup is busy. Try again shortly.')
  activeScans += 1
  const limits = { ...PROJECT_FILE_LIMITS }
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = overrides[key]
    if (value !== undefined && Number.isSafeInteger(value) && value > 0) {
      // Internal overrides can lower budgets for tests, never raise production limits.
      Object.assign(limits, { [key]: Math.min(value, limits[key]) })
    }
  }
  const deadline = Date.now() + limits.milliseconds
  const result: ProjectFileList = {
    projectId: project.id, paths: [], source: null, truncated: false, warnings: [], error: null
  }
  let visited = 0
  let resultBytes = 0
  const paths = new Set<string>()
  const warnUnreadable = (): void => {
    if (!result.warnings.includes('unreadable')) result.warnings.push('unreadable')
  }
  const expired = (): boolean => {
    if (Date.now() < deadline) return false
    result.truncated = true
    result.error = { code: 'timeout', message: 'File lookup timed out. Results may be incomplete.' }
    return true
  }
  const full = (): boolean => {
    if (expired()) return true
    if (visited >= limits.entries || paths.size >= limits.results || resultBytes >= limits.bytes) {
      result.truncated = true
      return true
    }
    return false
  }
  const add = (path: string): void => {
    if (paths.has(path)) return
    const bytes = Buffer.byteLength(path) + 1
    if (resultBytes + bytes > limits.bytes) {
      result.truncated = true
      resultBytes = limits.bytes
      return
    }
    resultBytes += bytes
    paths.add(path)
  }
  try {
    const root = await realpath(project.path)
    if (!(await lstat(root)).isDirectory()) throw new Error('Not a directory')
    const env = gitEnvironment()
    const gitArgs = ['-c', 'core.fsmonitor=false']
    let repository = false
    try {
      const probe = await execFileAsync('git', [...gitArgs, 'rev-parse', '--is-inside-work-tree'], {
        cwd: root, env, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 4096, windowsHide: true
      })
      repository = probe.stdout.trim() === 'true'
      if (!repository) return projectFileError(project.id, 'git-failed', 'Choose a project working directory, not Git repository internals.')
    } catch (error) {
      if (expired()) return result
      const failure = error as NodeJS.ErrnoException & { stderr?: string }
      if (failure.code === 'ENOENT') result.warnings.push('git-unavailable')
      else if (!failure.stderr?.includes('not a git repository (')) {
        return projectFileError(project.id, 'git-failed', 'Git could not list this project. Check repository access and try again.')
      }
    }

    // Reject every symlink, including links pointing back inside the project.
    // Recheck real paths around directory reads to catch moved/replaced parents.
    const confined = async (parts: string[], directory: boolean): Promise<boolean> => {
      let path = root
      if (!(await lstat(root)).isDirectory()) return false
      for (let index = 0; index < parts.length; index += 1) {
        path = join(path, parts[index])
        const stat = await lstat(path)
        if (stat.isSymbolicLink()) return false
        if (index < parts.length - 1 && !stat.isDirectory()) return false
        if (index === parts.length - 1 && !(directory ? stat.isDirectory() : stat.isFile())) return false
      }
      return within(root, await realpath(path)) && await realpath(root) === root
    }

    if (repository) {
      result.source = 'git'
      const candidates: string[] = []
      const child = spawn('git', [...gitArgs, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.', ...gitExclusions], {
        cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      })
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      // Attach immediately so a spawn failure cannot become an unhandled rejection.
      void closed.catch(() => {})
      const timer = setTimeout(() => { expired(); child.kill('SIGKILL') }, Math.max(1, deadline - Date.now()))
      let pending = Buffer.alloc(0)
      let bytes = 0
      let stopped = false
      try {
        for await (const chunk of child.stdout) {
          const buffer = chunk as Buffer
          const remaining = limits.bytes - bytes
          bytes += buffer.length
          pending = Buffer.concat([pending, buffer.subarray(0, Math.max(0, remaining))])
          let end: number
          while ((end = pending.indexOf(0)) !== -1 && candidates.length < limits.entries) {
            const raw = pending.subarray(0, end)
            const path = raw.toString('utf8')
            // Invalid UTF-8 cannot round trip through the renderer as a filename.
            if (Buffer.from(path).equals(raw)) candidates.push(path)
            pending = pending.subarray(end + 1)
          }
          if (bytes >= limits.bytes || candidates.length >= limits.entries || expired()) {
            result.truncated = true
            stopped = true
            child.kill('SIGKILL')
            break
          }
        }
        const code = await closed
        if (code !== 0 && !stopped && !result.error) {
          return projectFileError(project.id, 'git-failed', 'Git could not list this project. Check repository access and try again.')
        }
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill('SIGKILL')
      }
      for (const path of candidates) {
        if (full()) break
        visited += 1
        const parts = projectFileParts(path)
        if (!parts) continue
        if (parts.length > limits.depth) { result.truncated = true; continue }
        try {
          if (await confined(parts, false)) add(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnUnreadable()
        }
      }
    } else {
      result.source = 'directory'
      const walk = async (parts: string[]): Promise<void> => {
        if (full()) return
        if (parts.length >= limits.depth) { result.truncated = true; return }
        try {
          if (!await confined(parts, true)) return
          const directory = await opendir(join(root, ...parts))
          try {
            while (!full()) {
              if (!await confined(parts, true)) break
              const entry = await directory.read()
              if (!entry || !await confined(parts, true)) break
              visited += 1
              if (excluded.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue
              const childParts = [...parts, entry.name]
              const path = childParts.join('/')
              if (!projectFileParts(path)) continue
              if (entry.isDirectory()) await walk(childParts)
              else if (entry.isFile() && await confined(childParts, false)) add(path)
            }
          } finally {
            await directory.close()
          }
        } catch (error) {
          if (!parts.length) throw error
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnUnreadable()
        }
      }
      await walk([])
    }
    // The project may have been deleted or replaced during enumeration.
    if (await realpath(project.path) !== root || !await confined([], true)) throw new Error('Project changed')
    result.paths = [...paths].sort()
    return result
  } catch {
    return projectFileError(project.id, 'unavailable', 'Project directory is missing or unreadable. Reopen the project and try again.')
  } finally {
    activeScans -= 1
  }
}
