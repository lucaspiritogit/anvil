import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { SERVER_AUTH_FILENAME, ServerAuth } from '../src/server/server-auth'

const directories: string[] = []

async function fixture(): Promise<{ auth: ServerAuth; directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-server-auth-'))
  directories.push(directory)
  return {
    auth: new ServerAuth(directory),
    directory,
    path: join(directory, SERVER_AUTH_FILENAME)
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('server authentication storage', () => {
  test('reports missing storage and rejects empty passwords', async () => {
    const { auth } = await fixture()

    await expect(auth.status()).resolves.toEqual({ configured: false, reason: 'missing' })
    await expect(auth.verifyPassword('candidate')).resolves.toBe(false)
    await expect(auth.setPassword('')).rejects.toThrow('must not be empty')
  })

  test('creates an Argon2id hash without persisting plaintext', async () => {
    const { auth, path } = await fixture()

    await expect(auth.setPassword('correct horse battery staple')).resolves.toEqual({ configured: true })
    const contents = await readFile(path, 'utf8')
    const record = JSON.parse(contents) as Record<string, unknown>

    expect(record).toMatchObject({ version: 1, algorithm: 'argon2id' })
    expect(record.hash).toMatch(/^\$argon2id\$/)
    expect(contents).not.toContain('correct horse battery staple')
    await expect(auth.status()).resolves.toEqual({ configured: true })
    await expect(auth.verifyPassword('correct horse battery staple')).resolves.toBe(true)
    await expect(auth.verifyPassword('wrong password')).resolves.toBe(false)
  })

  test('atomically replaces the stored password', async () => {
    const { auth, directory, path } = await fixture()
    await auth.setPassword('first password')
    const first = JSON.parse(await readFile(path, 'utf8')) as { hash: string }

    await auth.setPassword('replacement password')
    const replacement = JSON.parse(await readFile(path, 'utf8')) as { hash: string }

    expect(replacement.hash).not.toBe(first.hash)
    await expect(auth.verifyPassword('first password')).resolves.toBe(false)
    await expect(auth.verifyPassword('replacement password')).resolves.toBe(true)
    expect(await readdir(directory)).toEqual([SERVER_AUTH_FILENAME])
  })

  test.each([
    ['invalid JSON', '{'],
    ['unsupported version', JSON.stringify({ version: 2, algorithm: 'argon2id', hash: '$argon2id$bad' })],
    ['invalid hash', JSON.stringify({ version: 1, algorithm: 'argon2id', hash: '$argon2id$bad' })]
  ])('treats %s as unconfigured', async (_label, contents) => {
    const { auth, path } = await fixture()
    await writeFile(path, contents, { mode: 0o600 })

    await expect(auth.status()).resolves.toEqual({ configured: false, reason: 'malformed' })
    await expect(auth.verifyPassword('candidate')).resolves.toBe(false)
  })

  test.runIf(process.platform !== 'win32')('creates and repairs the auth file with mode 0600', async () => {
    const { auth, path } = await fixture()
    await auth.setPassword('password')
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    await chmod(path, 0o644)
    await expect(auth.status()).resolves.toEqual({ configured: true })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
