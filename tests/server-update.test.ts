import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ServerUpdateState } from '@anvil/protocol/server-updates'
import {
  SERVER_UPDATE_CACHE_MS,
  checksumFor,
  createArchiveInstaller,
  createServerUpdates,
  manifestVersion,
  serverArchiveName,
  updateManifestName,
  type ServerInstaller
} from '../apps/server/src/server-update'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function manifest(version: string): Response {
  return new Response(`version: ${version}\nfiles:\n  - url: Anvil-${version}.AppImage\npath: Anvil-${version}.AppImage\n`)
}

function feed(...responses: Array<Response | Error>) {
  return vi.fn(async (_url: string) => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch')
    if (next instanceof Error) throw next
    return next
  })
}

describe('server update helpers', () => {
  test('reads the published version and checksums', () => {
    expect(manifestVersion("version: 2.4.0\nreleaseDate: '2026-11-10'\n")).toBe('2.4.0')
    expect(manifestVersion("version: '2.5.0-beta.1'\n")).toBe('2.5.0-beta.1')
    expect(manifestVersion('files: []\n')).toBeNull()
    expect(updateManifestName('linux')).toBe('latest-linux.yml')
    expect(updateManifestName('darwin')).toBe('latest-mac.yml')
    expect(serverArchiveName('2.5.0', 'darwin', 'arm64')).toBe('Anvil-server-2.5.0-macos-arm64')
    const sums = `${'a'.repeat(64)}  ./Anvil-2.5.0.AppImage\n${'b'.repeat(64)}  ./Anvil-server-2.5.0-linux-x64.tar.gz\n`
    expect(checksumFor(sums, 'Anvil-server-2.5.0-linux-x64.tar.gz')).toBe('b'.repeat(64))
    expect(checksumFor(sums, 'Anvil-server-2.5.0-linux-arm64.tar.gz')).toBeNull()
  })
})

describe('server updates', () => {
  test('does not report an update when the published version is already installed', async () => {
    const request = feed(manifest('2.4.0'))
    const updates = createServerUpdates({ currentVersion: '2.4.0', fetch: request, platform: 'linux', feedUrl: 'https://feed.test' })
    expect(await updates.check()).toMatchObject({ currentVersion: '2.4.0', latestVersion: '2.4.0', available: false, installable: false })
    expect(request).toHaveBeenCalledWith('https://feed.test/latest-linux.yml', expect.anything())
  })

  test('reports a newer published version, caches it and refreshes on demand', async () => {
    let clock = 1_000
    const changes: ServerUpdateState[] = []
    const request = feed(manifest('2.5.0'), manifest('2.6.0'), manifest('2.6.0'))
    const updates = createServerUpdates({
      currentVersion: '2.4.0', fetch: request, now: () => clock, onChange: (state) => changes.push(state)
    })
    expect(await updates.check()).toMatchObject({ latestVersion: '2.5.0', available: true })
    await updates.check()
    expect(request).toHaveBeenCalledTimes(1)
    expect((await updates.check(true)).latestVersion).toBe('2.6.0')
    clock += SERVER_UPDATE_CACHE_MS
    await updates.check()
    expect(request).toHaveBeenCalledTimes(3)
    expect(changes.at(-1)).toMatchObject({ latestVersion: '2.6.0', available: true })
  })

  test('keeps the last result when the feed fails', async () => {
    const request = feed(manifest('2.5.0'), new Response('nope', { status: 500 }))
    const updates = createServerUpdates({ currentVersion: '2.4.0', fetch: request })
    await updates.check()
    await expect(updates.check(true)).rejects.toThrow('Update feed responded with 500')
    expect(updates.state()).toMatchObject({ latestVersion: '2.5.0', available: true })
  })

  test('refuses to install without an installer or without a newer version', async () => {
    const manual = createServerUpdates({ currentVersion: '2.4.0', fetch: feed(manifest('2.5.0')) })
    await expect(manual.install()).rejects.toThrow('cannot update itself')
    const installer: ServerInstaller = { install: vi.fn(async () => {}), restart: vi.fn(async () => {}) }
    const current = createServerUpdates({ currentVersion: '2.4.0', fetch: feed(manifest('2.4.0')), installer })
    await expect(current.install()).rejects.toThrow('already up to date')
    expect(installer.install).not.toHaveBeenCalled()
  })

  test('installs the newer version, reports progress and restarts once', async () => {
    const changes: ServerUpdateState[] = []
    const installer: ServerInstaller = {
      install: vi.fn(async (_version, report) => {
        report('downloading', 50)
        report('installing', null)
      }),
      restart: vi.fn(async () => {})
    }
    const updates = createServerUpdates({
      currentVersion: '2.4.0', fetch: feed(manifest('2.5.0')), installer, restartDelayMs: 0, onChange: (state) => changes.push(state)
    })
    expect((await updates.install()).phase).not.toBe('idle')
    await updates.install()
    await vi.waitFor(() => expect(installer.restart).toHaveBeenCalledOnce())
    expect(installer.install).toHaveBeenCalledExactlyOnceWith('2.5.0', expect.any(Function))
    expect(changes.map((state) => `${state.phase}:${state.progress}`)).toEqual([
      'idle:null', 'downloading:0', 'downloading:50', 'installing:null', 'restarting:null'
    ])
  })

  test('surfaces an install failure and allows a retry', async () => {
    const installer: ServerInstaller = {
      install: vi.fn().mockRejectedValueOnce(new Error('The downloaded update did not match its checksum')).mockResolvedValue(undefined),
      restart: vi.fn(async () => {})
    }
    const updates = createServerUpdates({
      currentVersion: '2.4.0', fetch: feed(manifest('2.5.0'), manifest('2.5.0')), installer, restartDelayMs: 0
    })
    await updates.install()
    await vi.waitFor(() => expect(updates.state()).toMatchObject({
      phase: 'idle', available: true, error: 'The downloaded update did not match its checksum'
    }))
    expect(installer.restart).not.toHaveBeenCalled()
    await updates.install()
    await vi.waitFor(() => expect(installer.restart).toHaveBeenCalledOnce())
    expect(updates.state().error).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('server archive installer', () => {
  function layout(version: string): { parent: string; build: (name: string) => string } {
    const parent = mkdtempSync(join(tmpdir(), 'anvil-update-'))
    directories.push(parent)
    const build = (name: string): string => {
      const root = join(parent, name)
      mkdirSync(join(root, 'app', 'server'), { recursive: true })
      mkdirSync(join(root, 'runtime'), { recursive: true })
      writeFileSync(join(root, 'app', 'server', 'index.js'), `module.exports = '${version}'\n`)
      writeFileSync(join(root, 'anvil-server'), '#!/bin/sh\n')
      chmodSync(join(root, 'anvil-server'), 0o755)
      writeFileSync(join(root, 'runtime', 'node'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(root, 'runtime', 'node'), 0o755)
      return root
    }
    return { parent, build }
  }

  function release(version: string, corrupt = false) {
    const staging = layout(version)
    const name = serverArchiveName(version, process.platform, process.arch)
    staging.build(name)
    const archive = join(staging.parent, `${name}.tar.gz`)
    execFileSync('tar', ['-czf', archive, '-C', staging.parent, name])
    const bytes = readFileSync(archive)
    const hash = corrupt ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')
    return vi.fn(async (url: string) => {
      if (url === `https://releases.test/v${version}/SHA256SUMS.txt`) return new Response(`${hash}  ./${name}.tar.gz\n`)
      if (url === `https://releases.test/v${version}/${name}.tar.gz`) {
        return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } })
      }
      return new Response('missing', { status: 404 })
    })
  }

  test('is unavailable outside a packaged server layout', () => {
    const options = { arguments: [], close: async () => {} }
    expect(createArchiveInstaller({ ...options, entry: undefined })).toBeUndefined()
    expect(createArchiveInstaller({ ...options, entry: join(tmpdir(), 'out', 'server', 'index.js') })).toBeUndefined()
    const { build } = layout('2.4.0')
    expect(createArchiveInstaller({ ...options, entry: join(build('anvil'), 'app', 'server', 'index.js'), platform: 'win32' })).toBeUndefined()
  })

  test('verifies the archive and repoints a symlinked install', async () => {
    const { parent, build } = layout('2.4.0')
    const installed = build('anvil-server-2.4.0-old')
    const current = join(parent, 'anvil-server-current')
    symlinkSync(installed, current)
    const installer = createArchiveInstaller({
      entry: join(current, 'app', 'server', 'index.js'), arguments: ['--headless'], close: async () => {},
      fetch: release('2.5.0'), releaseUrl: 'https://releases.test'
    })!
    const phases: string[] = []
    await installer.install('2.5.0', (phase) => { if (phases.at(-1) !== phase) phases.push(phase) })
    expect(phases).toEqual(['downloading', 'installing'])
    expect(lstatSync(current).isSymbolicLink()).toBe(true)
    expect(realpathSync(current)).not.toBe(realpathSync(installed))
    expect(readFileSync(join(current, 'app', 'server', 'index.js'), 'utf8')).toContain('2.5.0')
    expect(readFileSync(join(installed, 'app', 'server', 'index.js'), 'utf8')).toContain('2.4.0')
    expect(readdirSync(parent).filter((name) => name.startsWith('.anvil-server-update-'))).toEqual([])
  })

  test('replaces a plain install directory and keeps the previous one', async () => {
    const { parent, build } = layout('2.4.0')
    const root = build('anvil')
    const installer = createArchiveInstaller({
      entry: join(root, 'app', 'server', 'index.js'), arguments: [], close: async () => {},
      fetch: release('2.5.0'), releaseUrl: 'https://releases.test'
    })!
    await installer.install('2.5.0', () => {})
    expect(readFileSync(join(root, 'app', 'server', 'index.js'), 'utf8')).toContain('2.5.0')
    const previous = readdirSync(parent).find((name) => name.startsWith('anvil.previous-'))
    expect(readFileSync(join(parent, previous!, 'app', 'server', 'index.js'), 'utf8')).toContain('2.4.0')
  })

  test('leaves the install untouched when the checksum does not match', async () => {
    const { parent, build } = layout('2.4.0')
    const root = build('anvil')
    const installer = createArchiveInstaller({
      entry: join(root, 'app', 'server', 'index.js'), arguments: [], close: async () => {},
      fetch: release('2.5.0', true), releaseUrl: 'https://releases.test'
    })!
    await expect(installer.install('2.5.0', () => {})).rejects.toThrow('did not match its checksum')
    expect(readFileSync(join(root, 'app', 'server', 'index.js'), 'utf8')).toContain('2.4.0')
    expect(readdirSync(parent)).toEqual(['anvil'])
  })

  test('explains when the release has no build for this platform', async () => {
    const { build } = layout('2.4.0')
    const root = build('anvil')
    const installer = createArchiveInstaller({
      entry: join(root, 'app', 'server', 'index.js'), arguments: [], close: async () => {},
      fetch: release('2.5.0'), releaseUrl: 'https://releases.test', arch: 'riscv64'
    })!
    await expect(installer.install('2.5.0', () => {})).rejects.toThrow('has no server build for')
  })
})
