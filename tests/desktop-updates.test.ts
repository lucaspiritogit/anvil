import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { DesktopUpdates, desktopUpdatesSupported, type UpdaterLike } from '../apps/desktop/src/main/desktop-updates'
// @ts-expect-error The release script is plain JavaScript.
import { mergeMacManifests } from '../scripts/merge-mac-update-manifests.mjs'

class FakeUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update')
    return null
  })
  quitAndInstall = vi.fn()
}

function create(updater: FakeUpdater | null = new FakeUpdater()) {
  const changes: string[] = []
  const updates = new DesktopUpdates(updater as unknown as UpdaterLike | null, '2.3.0', (state) => changes.push(state.status), () => 42)
  return { updater, updates, changes }
}

describe('desktop update support', () => {
  const base = { releaseBuild: true, packaged: true, platform: 'win32' as NodeJS.Platform, env: {}, hasUpdateConfig: true }

  test('only enables release builds with update config', () => {
    expect(desktopUpdatesSupported(base)).toBe(true)
    expect(desktopUpdatesSupported({ ...base, releaseBuild: false })).toBe(false)
    expect(desktopUpdatesSupported({ ...base, packaged: false })).toBe(false)
    expect(desktopUpdatesSupported({ ...base, hasUpdateConfig: false })).toBe(false)
    expect(desktopUpdatesSupported({ ...base, env: { ANVIL_DISABLE_AUTO_UPDATE: '1' } })).toBe(false)
  })

  test('requires an AppImage on Linux', () => {
    expect(desktopUpdatesSupported({ ...base, platform: 'linux' })).toBe(false)
    expect(desktopUpdatesSupported({ ...base, platform: 'linux', env: { APPIMAGE: '/opt/Anvil.AppImage' } })).toBe(true)
  })
})

describe('desktop updates', () => {
  test('reports unsupported builds without checking', async () => {
    const { updates } = create(null)
    expect((await updates.check()).status).toBe('unsupported')
    expect(() => updates.install()).toThrow()
  })

  test('tracks download progress until the update is ready', async () => {
    const { updater, updates } = create()
    expect(updater?.autoDownload).toBe(true)
    expect(updater?.autoInstallOnAppQuit).toBe(true)
    await updates.check()
    expect(updates.state().status).toBe('checking')
    updater?.emit('update-available', { version: '2.4.0' })
    updater?.emit('download-progress', { percent: 55.5 })
    expect(updates.state()).toMatchObject({ status: 'downloading', version: '2.4.0', progress: 55.5 })
    await updates.check()
    expect(updater?.checkForUpdates).toHaveBeenCalledTimes(1)
    updater?.emit('update-downloaded', { version: '2.4.0' })
    updater?.emit('error', new Error('late failure'))
    expect(updates.state()).toMatchObject({ status: 'downloaded', version: '2.4.0', error: null })
    updates.install()
    expect(updater?.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  test('reports failures with a short message', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('HttpError: 404\n<html>long body</html>'))
    const { updates } = create(updater)
    await updates.check()
    expect(updates.state()).toMatchObject({ status: 'error', error: 'HttpError: 404', checkedAt: 42 })
  })

  test('reports when the app is up to date', async () => {
    const { updater, updates } = create()
    await updates.check()
    updater?.emit('update-not-available', { version: '2.3.0' })
    expect(updates.state()).toMatchObject({ status: 'up-to-date', version: null })
  })
})

describe('macOS update manifests', () => {
  const file = (url: string) => ({ url, sha512: url, size: 1 })

  test('merges both architectures into one manifest', () => {
    const merged = mergeMacManifests([
      { version: '2.4.0', files: [file('Anvil-2.4.0-arm64-mac.zip'), file('Anvil-2.4.0-arm64.dmg')], path: 'Anvil-2.4.0-arm64-mac.zip', releaseDate: '2026-01-01T00:00:00.000Z' },
      { version: '2.4.0', files: [file('Anvil-2.4.0-x64-mac.zip')], path: 'Anvil-2.4.0-x64-mac.zip', releaseDate: '2026-01-02T00:00:00.000Z' }
    ])
    expect(merged.files.map((entry: { url: string }) => entry.url)).toEqual([
      'Anvil-2.4.0-arm64-mac.zip', 'Anvil-2.4.0-arm64.dmg', 'Anvil-2.4.0-x64-mac.zip'
    ])
    expect(merged.path).toBe('Anvil-2.4.0-x64-mac.zip')
    expect(merged.releaseDate).toBe('2026-01-02T00:00:00.000Z')
  })

  test('rejects manifests for different versions', () => {
    expect(() => mergeMacManifests([{ version: '2.4.0', files: [] }, { version: '2.3.0', files: [] }])).toThrow()
  })
})
