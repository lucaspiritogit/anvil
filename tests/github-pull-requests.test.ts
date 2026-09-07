import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubClient } from '../src/main/github-client'
import { GitHubCredentials } from '../src/main/github-credentials'
import { GitHubPullRequests } from '../src/main/github-pull-requests'
import type { PullRequestPreview } from '../src/shared/types'

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-github-'))
  const token = 'test-secret-token'
  const encrypted = Buffer.from('opaque-encrypted-token')
  const encryption = {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain',
    encryptString: (value: string) => { assert.equal(value, token); return encrypted },
    decryptString: (value: Buffer) => { assert.deepEqual(value, encrypted); return token }
  }
  try {
    const path = join(directory, 'github-token.enc')
    const credentials = new GitHubCredentials(path, encryption)
    assert.deepEqual(await credentials.status(), { configured: false })
    await credentials.setToken(token)
    assert.deepEqual(await credentials.status(), { configured: true })
    assert.deepEqual(await readFile(path), encrypted)
    assert.equal(await new GitHubCredentials(path, encryption).getToken(), token, 'Encrypted credentials survive restart')
    await assert.rejects(new GitHubCredentials(path, { ...encryption, getSelectedStorageBackend: () => 'basic_text' }).setToken(token), /Secure token storage is unavailable/)
    await assert.rejects(new GitHubCredentials(path, { ...encryption, isEncryptionAvailable: () => false }).getToken(), /Secure token storage is unavailable/)

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
      assert.equal(new URL(String(url)).origin, 'https://api.github.com')
      assert.equal(options?.redirect, 'error', 'Never forward the token to a redirect')
      assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${token}`)
      requests.push({ path, options: options! })
      if (path === '/user') return Response.json({ login: account, type: 'User' })
      if (options?.method === 'POST') {
        if (failure) return Response.json({}, { status: 403 })
        existing = true
        if (responseLost) throw new Error('Connection lost')
        return Response.json(pull, { status: 201 })
      }
      const params = new URL(String(url)).searchParams
      assert.equal(params.get('head'), 'developer:task/feature')
      assert.equal(params.get('base'), 'main')
      return Response.json(existing ? [pull] : [])
    })
    let pushes = 0
    let pushFailure = false
    const git = {
      getPullRequestPreview: async () => preview,
      pushPullRequestBranch: async (_path: string, expected: PullRequestPreview) => {
        assert.deepEqual(expected, preview)
        pushes += 1
        if (pushFailure) throw new Error('Push rejected')
      }
    }
    const service = new GitHubPullRequests(git, credentials, client)
    assert.deepEqual(await service.preview('/project', preview.sourceBranch), preview)
    assert.equal(pushes, 0, 'Preview does not push')
    const result = await service.open('/project', preview.sourceBranch, preview, 'My title', 'My description')
    assert.equal(result.number, 42)
    assert.equal(result.author, 'developer')
    assert.equal(result.existing, false)
    assert.deepEqual(JSON.parse(requests.find((request) => request.options.method === 'POST')!.options.body as string), {
      title: 'My title', body: 'My description', head: preview.sourceBranch, base: 'main'
    })
    assert.equal((await service.open('/project', preview.sourceBranch, preview, 'Other title', '')).existing, true)
    assert.equal(requests.filter((request) => request.options.method === 'POST').length, 1, 'Retries reuse an existing PR')
    existing = false
    responseLost = true
    assert.equal((await service.open('/project', preview.sourceBranch, preview, 'My title', '')).existing, true, 'Recover a PR created before a connection failure')
    responseLost = false
    existing = false
    failure = true
    await assert.rejects(service.open('/project', preview.sourceBranch, preview, 'My title', ''), /branch was pushed.*PR could not be confirmed/)
    const countBeforePushFailure = requests.length
    pushFailure = true
    await assert.rejects(service.open('/project', preview.sourceBranch, preview, 'My title', ''), /Push rejected/)
    assert.equal(requests.length, countBeforePushFailure + 1, 'Only validate account when Git push fails; do not create PR')
    pushFailure = false
    account = 'different-user'
    const pushesBeforeAccountChange = pushes
    await assert.rejects(service.open('/project', preview.sourceBranch, preview, 'My title', ''), /account changed/)
    assert.equal(pushes, pushesBeforeAccountChange)
    await assert.rejects(service.open('/project', preview.sourceBranch, preview, '', ''), /PR title/)
    await assert.rejects(service.open('/project', preview.sourceBranch, { ...preview, commitCount: 0 }, 'My title', ''), /no commits/)
    await credentials.removeToken()
    assert.deepEqual(await credentials.status(), { configured: false })
    await assert.rejects(credentials.getToken(), /GitHub token in Settings/)
    const invalidClient = new GitHubClient(async () => Response.json({ type: 'Bot', login: 'bot' }))
    await assert.rejects(invalidClient.account(token), /personal GitHub token/)
    const deniedClient = new GitHubClient(async () => Response.json({ message: token }, { status: 401 }))
    await assert.rejects(deniedClient.account(token), (error: Error) => /rejected the token/.test(error.message) && !error.message.includes(token))
    console.log('GitHub PR passed: encrypted token storage, user attribution, payloads, existing PR recovery, push/API failures, and stale account guards.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
