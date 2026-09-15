import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  SERVER_CONNECTION_SETTINGS_FILENAME,
  ServerConnectionSettings,
  resolveServerTarget
} from '../src/client/main/server-connection-settings'
import { normalizeServerTarget, serverAddress } from '../src/shared/server-address'

const directories: string[] = []

async function fixture(): Promise<{ directory: string; path: string; settings: ServerConnectionSettings }> {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-server-connection-'))
  directories.push(directory)
  return {
    directory,
    path: join(directory, SERVER_CONNECTION_SETTINGS_FILENAME),
    settings: new ServerConnectionSettings(directory)
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Anvil server target normalization', () => {
  test('canonicalizes HTTP and HTTPS origins', () => {
    expect(serverAddress('https://Anvil.Example:443/')).toBe('https://anvil.example')
    expect(serverAddress('http://192.168.1.20:4780/')).toBe('http://192.168.1.20:4780')
    expect(normalizeServerTarget({ mode: 'local' })).toEqual({ mode: 'local' })
    expect(normalizeServerTarget({ mode: 'remote', url: 'https://anvil.example/' }))
      .toEqual({ mode: 'remote', url: 'https://anvil.example' })
  })

  test.each([
    ['not a url', 'valid HTTP or HTTPS URL'],
    ['ftp://anvil.example', 'must use HTTP or HTTPS'],
    ['https://user:secret@anvil.example', 'cannot include credentials'],
    ['https://anvil.example/rpc', 'cannot include a path'],
    ['https://anvil.example/?workspace=one', 'cannot include a query string'],
    ['https://anvil.example/?', 'cannot include a query string'],
    ['https://anvil.example/#status', 'cannot include a fragment'],
    ['https://anvil.example/#', 'cannot include a fragment']
  ])('rejects %s', (value, message) => {
    expect(() => serverAddress(value)).toThrow(message)
  })
})

describe('Electron server connection settings', () => {
  test('atomically saves and replaces explicit remote and local choices', async () => {
    const { directory, path, settings } = await fixture()

    await expect(settings.save({ mode: 'remote', url: 'https://Anvil.Example:443/' }))
      .resolves.toEqual({ mode: 'remote', url: 'https://anvil.example' })
    await expect(settings.load()).resolves.toEqual({ mode: 'remote', url: 'https://anvil.example' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      target: { mode: 'remote', url: 'https://anvil.example' }
    })

    await expect(settings.save({ mode: 'local' })).resolves.toEqual({ mode: 'local' })
    await expect(settings.load()).resolves.toEqual({ mode: 'local' })
    expect(await readdir(directory)).toEqual([SERVER_CONNECTION_SETTINGS_FILENAME])
  })

  test('tolerates missing and malformed preference data', async () => {
    const { path, settings } = await fixture()
    await expect(settings.load()).resolves.toBeUndefined()

    for (const contents of [
      '{',
      JSON.stringify({ version: 2, target: { mode: 'local' } }),
      JSON.stringify({ version: 1, target: { mode: 'remote', url: 'file:///tmp/anvil' } })
    ]) {
      await writeFile(path, contents)
      await expect(settings.load()).resolves.toBeUndefined()
    }
  })

  test('uses saved choice, environment bootstrap, then the built-in local server', async () => {
    const { path, settings } = await fixture()
    const environment = { ANVIL_SERVER_URL: 'https://bootstrap.example/' }

    await expect(settings.resolve(environment)).resolves.toEqual({ mode: 'remote', url: 'https://bootstrap.example' })
    expect(resolveServerTarget(undefined, {})).toEqual({ mode: 'local' })

    await settings.save({ mode: 'local' })
    await expect(settings.resolve(environment)).resolves.toEqual({ mode: 'local' })

    await settings.save({ mode: 'remote', url: 'https://saved.example/' })
    await expect(settings.resolve(environment)).resolves.toEqual({ mode: 'remote', url: 'https://saved.example' })

    await writeFile(path, '{')
    await expect(settings.resolve(environment)).resolves.toEqual({ mode: 'remote', url: 'https://bootstrap.example' })
  })

  test('rejects an invalid replacement without changing the saved choice', async () => {
    const { settings } = await fixture()
    await settings.save({ mode: 'local' })

    await expect(settings.save({ mode: 'remote', url: 'https://anvil.example/workspace' }))
      .rejects.toThrow('cannot include a path')
    await expect(settings.load()).resolves.toEqual({ mode: 'local' })
  })
})
