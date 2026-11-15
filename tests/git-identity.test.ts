import { expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceGitIdentity } from '../apps/server/src/git-identity'
import { onTestCleanup } from './test-cleanup'

function workspace() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-git-identity-')))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const project = join(directory, 'external-project')
  mkdirSync(join(directory, 'home'), { recursive: true })
  mkdirSync(project)
  writeFileSync(join(directory, 'home', '.gitconfig'), '[user]\n')
  const identity = vi.fn(async () => ({ name: 'Octo Cat', email: '1+octocat@users.noreply.github.com' }))
  const token = vi.fn(async () => 'token')
  const resolver = new WorkspaceGitIdentity({ workspaces: () => [{ id: 'default', directory, projectPaths: [project] }], token, identity })
  const read = (key: string): string => execFileSync('git', ['config', '--file', join(directory, 'home', '.gitconfig'), '--get', key], { encoding: 'utf8' }).trim()
  return { directory, project, identity, token, resolver, read }
}

test('resolves the GitHub identity for project paths and fills an empty agent home identity once', async () => {
  const { directory, project, identity, resolver, read } = workspace()
  expect(await resolver.forPath(join(project, 'src'))).toEqual({ name: 'Octo Cat', email: '1+octocat@users.noreply.github.com' })
  expect(await resolver.forPath(join(directory, 'worktrees', 'task'))).toEqual({ name: 'Octo Cat', email: '1+octocat@users.noreply.github.com' })
  expect(await resolver.forPath(tmpdir())).toBeUndefined()
  expect(identity).toHaveBeenCalledTimes(1)
  expect(read('user.name')).toBe('Octo Cat')
  expect(read('user.email')).toBe('1+octocat@users.noreply.github.com')
})

test('keeps an identity the agent home already has and retries after a missing token', async () => {
  const { directory, token, identity, resolver, read } = workspace()
  writeFileSync(join(directory, 'home', '.gitconfig'), '[user]\n\tname = Own Name\n\temail = own@example.test\n')
  await resolver.prepareAgentHome('default', directory)
  expect(token).not.toHaveBeenCalled()
  token.mockRejectedValueOnce(new Error('no token'))
  expect(await resolver.forWorkspace('default', directory)).toBeUndefined()
  expect(await resolver.forWorkspace('default', directory)).toBeDefined()
  expect(identity).toHaveBeenCalledTimes(1)
  expect(read('user.email')).toBe('own@example.test')
})
