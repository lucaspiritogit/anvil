import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ANVIL_REPOSITORY_URL, ANVIL_UPDATE_FEED_URL } from '@anvil/protocol/external-links'
import { compareVersions, parseVersion, type ServerUpdatePhase, type ServerUpdateState } from '@anvil/protocol/server-updates'

const run = promisify(execFile)

export const SERVER_UPDATE_CACHE_MS = 5 * 60_000
const MANIFEST_LIMIT = 64 * 1024
const ARCHIVE_LIMIT = 1024 * 1024 * 1024
const NATIVE_MODULE_CHECK = "require('argon2'); require('node-pty'); const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.prepare('SELECT 1').get(); db.close()"

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

export interface ServerInstaller {
  install(version: string, report: (phase: ServerUpdatePhase, progress: number | null) => void): Promise<void>
  restart(): Promise<void>
}

export interface ServerUpdatesOptions {
  currentVersion: string
  installer?: ServerInstaller
  onChange?(state: ServerUpdateState): void
  fetch?: Fetch
  now?(): number
  feedUrl?: string
  platform?: NodeJS.Platform
  restartDelayMs?: number
}

export function updateManifestName(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'latest-mac.yml' : platform === 'win32' ? 'latest.yml' : 'latest-linux.yml'
}

export function manifestVersion(manifest: string): string | null {
  const match = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(manifest)
  return match ? parseVersion(match[1]) : null
}

export function checksumFor(checksums: string, name: string): string | null {
  for (const line of checksums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(.+)$/i.exec(line.trim())
    if (match && match[2] === name) return match[1].toLowerCase()
  }
  return null
}

export function serverArchiveName(version: string, platform: NodeJS.Platform, arch: string): string {
  return `Anvil-server-${version}-${platform === 'darwin' ? 'macos' : platform}-${arch}`
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.split('\n').find((value) => value.trim())?.trim() ?? 'Update failed'
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

export function createServerUpdates(options: ServerUpdatesOptions) {
  const now = options.now ?? Date.now
  const request: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  const feedUrl = options.feedUrl ?? ANVIL_UPDATE_FEED_URL
  const manifest = updateManifestName(options.platform ?? process.platform)
  const currentVersion = parseVersion(options.currentVersion) ?? options.currentVersion
  let state: ServerUpdateState = {
    currentVersion,
    latestVersion: null,
    available: false,
    installable: options.installer !== undefined,
    phase: 'idle',
    progress: null,
    error: null,
    checkedAt: null
  }
  let checking: Promise<ServerUpdateState> | null = null
  let installing = false

  const update = (patch: Partial<ServerUpdateState>): void => {
    state = { ...state, ...patch }
    options.onChange?.(state)
  }

  const load = async (): Promise<ServerUpdateState> => {
    const response = await request(`${feedUrl}/${manifest}`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Update feed responded with ${response.status}`)
    const body = await response.text()
    const latestVersion = body.length <= MANIFEST_LIMIT ? manifestVersion(body) : null
    if (!latestVersion) throw new Error('Unexpected update feed response')
    update({ latestVersion, available: compareVersions(latestVersion, currentVersion) > 0, checkedAt: now() })
    return state
  }

  const check = (force = false): Promise<ServerUpdateState> => {
    if (state.phase !== 'idle') return Promise.resolve(state)
    if (!force && state.checkedAt !== null && now() - state.checkedAt < SERVER_UPDATE_CACHE_MS) return Promise.resolve(state)
    checking ??= load().finally(() => { checking = null })
    return checking
  }

  const install = async (): Promise<ServerUpdateState> => {
    const installer = options.installer
    if (!installer) throw new Error('This Anvil server cannot update itself. Install the new release manually.')
    if (installing) return state
    installing = true
    try {
      await check(true)
    } catch (error) {
      installing = false
      throw error
    }
    const version = state.latestVersion
    if (!state.available || !version) {
      installing = false
      throw new Error('Anvil is already up to date.')
    }
    update({ phase: 'downloading', progress: 0, error: null })
    void (async () => {
      try {
        await installer.install(version, (phase, progress) => update({ phase, progress }))
        update({ phase: 'restarting', progress: null })
        await new Promise((done) => setTimeout(done, options.restartDelayMs ?? 750))
        await installer.restart()
      } catch (error) {
        installing = false
        update({ phase: 'idle', progress: null, error: message(error) })
      }
    })()
    return state
  }

  return { state: (): ServerUpdateState => state, check, install }
}

export type ServerUpdates = ReturnType<typeof createServerUpdates>

export interface ArchiveInstallerOptions {
  entry: string | undefined
  arguments: string[]
  close(): Promise<void>
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  pid?: number
  fetch?: Fetch
  releaseUrl?: string
}

function timestamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

async function systemdUnit(env: NodeJS.ProcessEnv, pid: number): Promise<{ name: string; user: boolean } | null> {
  if (env.SYSTEMD_EXEC_PID !== String(pid)) return null
  try {
    const group = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find((line) => line.startsWith('0::'))?.slice(3).trim() ?? ''
    const name = group.split('/').pop() ?? ''
    return /^[A-Za-z0-9:_.@\\-]+\.service$/.test(name) ? { name, user: group.includes('/user@') } : null
  } catch {
    return null
  }
}

async function download(request: Fetch, url: string, target: string, report: (progress: number | null) => void): Promise<string> {
  const response = await request(url)
  if (!response.ok || !response.body) throw new Error(`Could not download ${basename(target)} (${response.status})`)
  const total = Number(response.headers.get('content-length'))
  if (total > ARCHIVE_LIMIT) throw new Error('The update archive is larger than expected')
  const hash = createHash('sha256')
  const file = createWriteStream(target)
  let received = 0
  let reported = -1
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength
      if (received > ARCHIVE_LIMIT) throw new Error('The update archive is larger than expected')
      hash.update(chunk)
      if (!file.write(chunk)) await new Promise<void>((done) => file.once('drain', done))
      const percent = total > 0 ? Math.min(100, Math.floor(received / total * 100)) : -1
      if (percent !== reported && percent >= 0) {
        reported = percent
        report(percent)
      }
    }
  } finally {
    await new Promise<void>((done) => file.end(done))
  }
  return hash.digest('hex')
}

export function createArchiveInstaller(options: ArchiveInstallerOptions): ServerInstaller | undefined {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const env = options.env ?? process.env
  const request: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  const releaseUrl = options.releaseUrl ?? `${ANVIL_REPOSITORY_URL}/releases/download`
  if (platform === 'win32' || !options.entry) return undefined
  const entry = resolve(options.entry)
  const root = resolve(dirname(entry), '..', '..')
  if (basename(dirname(entry)) !== 'server' || basename(dirname(dirname(entry))) !== 'app') return undefined
  if (!existsSync(join(root, 'anvil-server')) || !existsSync(join(root, 'runtime', 'node'))) return undefined
  let linked: boolean
  let parent: string
  try {
    linked = lstatSync(root).isSymbolicLink()
    parent = dirname(linked ? realpathSync(root) : root)
  } catch {
    return undefined
  }

  return {
    async install(version, report) {
      const name = serverArchiveName(version, platform, arch)
      const archive = `${name}.tar.gz`
      const base = `${releaseUrl}/v${version}`
      const work = await mkdtemp(join(parent, '.anvil-server-update-'))
      try {
        report('downloading', 0)
        const sums = await request(`${base}/SHA256SUMS.txt`)
        if (!sums.ok) throw new Error(`Could not download the release checksums (${sums.status})`)
        const expected = checksumFor(await sums.text(), archive)
        if (!expected) throw new Error(`Anvil ${version} has no server build for ${platform} ${arch}`)
        const actual = await download(request, `${base}/${archive}`, join(work, archive), (progress) => report('downloading', progress))
        if (actual !== expected) throw new Error('The downloaded update did not match its checksum')
        report('installing', null)
        await run('tar', ['-xzf', join(work, archive), '-C', work])
        const extracted = join(work, name)
        if (!existsSync(join(extracted, 'anvil-server')) || !existsSync(join(extracted, 'app', 'server', 'index.js'))) {
          throw new Error('The update archive has unexpected contents')
        }
        await run(join(extracted, 'runtime', 'node'), ['-e', NATIVE_MODULE_CHECK], { cwd: join(extracted, 'app'), timeout: 60_000 })
        const stamp = timestamp()
        const target = join(parent, `anvil-server-${version}-${stamp}`)
        await rename(extracted, target)
        if (linked) {
          const next = `${root}.next`
          await rm(next, { force: true })
          await symlink(target, next)
          await rename(next, root)
        } else {
          const previous = `${root}.previous-${stamp}`
          await rename(root, previous)
          try {
            await rename(target, root)
          } catch (error) {
            await rename(previous, root)
            throw error
          }
        }
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    },
    async restart() {
      const unit = await systemdUnit(env, options.pid ?? process.pid)
      if (unit) {
        try {
          await run('systemctl', [...(unit.user ? ['--user'] : []), '--no-block', 'restart', unit.name])
          return
        } catch (error) {
          console.error('Could not restart the Anvil service through systemd:', error)
          await options.close().catch((closeError) => console.error(closeError))
          process.exit(1)
        }
      }
      await options.close().catch((error) => console.error(error))
      const child = spawn(join(root, 'anvil-server'), options.arguments.filter((argument) => argument !== '--headless'), {
        detached: true,
        stdio: 'inherit',
        env
      })
      child.unref()
      process.exit(0)
    }
  }
}
