import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubClient } from '../src/main/github-client'
import { GitHubCredentials } from '../src/main/github-credentials'
import { GitHubPullRequests } from '../src/main/github-pull-requests'
import type { PullRequestPreview } from '../src/shared/types'

test('stores encrypted credentials and creates or recovers PRs with account and failure guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-github-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const token = 'test-secret-token'
  const encrypted = Buffer.from('opaque-encrypted-token')
  const encryption = {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain',
    encryptString: (value: string) => { expect(value).toBe(token); return encrypted },
    decryptString: (value: Buffer) => { expect(value).toStrictEqual(encrypted); return token }
  }
  try {
    const path = join(directory, 'github-token.enc')
    const credentials = new GitHubCredentials(path, encryption)
    expect(await credentials.status()).toStrictEqual({ configured: false })
    await credentials.setToken(token)
    expect(await credentials.status()).toStrictEqual({ configured: true })
    expect(await readFile(path)).toStrictEqual(encrypted)
    expect(await new GitHubCredentials(path, encryption).getToken(), 'Encrypted credentials survive restart').toBe(token)
    await expect(new GitHubCredentials(path, { ...encryption, getSelectedStorageBackend: () => 'basic_text' }).setToken(token)).rejects.toThrow(/Secure token storage is unavailable/)
    await expect(new GitHubCredentials(path, { ...encryption, isEncryptionAvailable: () => false }).getToken()).rejects.toThrow(/Secure token storage is unavailable/)

    const preview: PullRequestPreview = {
      sourceBranch: 'task/feature', targetBranch: 'main', sourceCommit: 'source', targetCommit: 'local-base',
      remoteTargetCommit: 'remote-base', repository: 'developer/project', remote: 'origin', account: 'developer', commitCount: 2
    }
    const pull = { number: 42, html_url: 'https://github.com/developer/project/pull/42', title: 'My title', body: 'My description', user: { login: 'developer' }, head: { ref: preview.sourceBranch }, base: { ref: 'main' } }
    const requests: { path: string; options: RequestInit }[] = []
    let existing = false
    let failure = false
    let responseLost = false
    let account = 'developer'
    const client = new GitHubClient(async (url, options) => {
      const path = new URL(String(url)).pathname
      expect(new URL(String(url)).origin).toBe('https://api.github.com')
      expect(options?.redirect, 'Never forward the token to a redirect').toBe('error')
      expect((options?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`)
      requests.push({ path, options: options! })
      if (path === '/user') return Response.json({ login: account, type: 'User' })
      if (options?.method === 'POST') {
        if (failure) return Response.json({}, { status: 403 })
        existing = true
        if (responseLost) throw new Error('Connection lost')
        return Response.json(pull, { status: 201 })
      }
      const params = new URL(String(url)).searchParams
      expect(params.get('head')).toBe('developer:task/feature')
      expect(params.get('base')).toBe('main')
      return Response.json(existing ? [pull] : [])
    })
    let pushes = 0
    let pushFailure = false
    const git = {
      getPullRequestPreview: async () => preview,
      pushPullRequestBranch: async (_path: string, expected: PullRequestPreview) => {
        expect(expected).toStrictEqual(preview)
        pushes += 1
        if (pushFailure) throw new Error('Push rejected')
      }
    }
    const service = new GitHubPullRequests(git, credentials, client)
    expect(await service.preview('/project', preview.sourceBranch)).toStrictEqual(preview)
    expect(pushes, 'Preview does not push').toBe(0)
    const result = await service.open('/project', preview.sourceBranch, preview, 'My title', 'My description')
    expect(result.number).toBe(42)
    expect(result.author).toBe('developer')
    expect(result.existing).toBe(false)
    expect(JSON.parse(requests.find((request) => request.options.method === 'POST')!.options.body as string)).toStrictEqual({
      title: 'My title', body: 'My description', head: preview.sourceBranch, base: 'main'
    })
    expect((await service.open('/project', preview.sourceBranch, preview, 'Other title', '')).existing).toBe(true)
    expect(requests.filter((request) => request.options.method === 'POST').length, 'Retries reuse an existing PR').toBe(1)
    existing = false
    responseLost = true
    expect((await service.open('/project', preview.sourceBranch, preview, 'My title', '')).existing, 'Recover a PR created before a connection failure').toBe(true)
    responseLost = false
    existing = false
    failure = true
    await expect(service.open('/project', preview.sourceBranch, preview, 'My title', '')).rejects.toThrow(/branch was pushed.*PR could not be confirmed/)
    const countBeforePushFailure = requests.length
    pushFailure = true
    await expect(service.open('/project', preview.sourceBranch, preview, 'My title', '')).rejects.toThrow(/Push rejected/)
    expect(requests.length, 'Only validate account when Git push fails; do not create PR').toBe(countBeforePushFailure + 1)
    pushFailure = false
    account = 'different-user'
    const pushesBeforeAccountChange = pushes
    await expect(service.open('/project', preview.sourceBranch, preview, 'My title', '')).rejects.toThrow(/account changed/)
    expect(pushes).toBe(pushesBeforeAccountChange)
    await expect(service.open('/project', preview.sourceBranch, preview, '', '')).rejects.toThrow(/PR title/)
    await expect(service.open('/project', preview.sourceBranch, { ...preview, commitCount: 0 }, 'My title', '')).rejects.toThrow(/no commits/)
    await credentials.removeToken()
    expect(await credentials.status()).toStrictEqual({ configured: false })
    await expect(credentials.getToken()).rejects.toThrow(/GitHub token in Settings/)
    const invalidClient = new GitHubClient(async () => Response.json({ type: 'Bot', login: 'bot' }))
    await expect(invalidClient.account(token)).rejects.toThrow(/personal GitHub token/)
    const deniedClient = new GitHubClient(async () => Response.json({ message: token }, { status: 401 }))
    await expect(deniedClient.account(token)).rejects.toSatisfy((error: Error) => /rejected the token/.test(error.message) && !error.message.includes(token))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
