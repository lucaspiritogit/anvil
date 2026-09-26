import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { resolveWorkspaceDirectory } from '@anvil/app-data'
import { createAnvilHttpServer, RPC_BODY_LIMIT } from '../apps/server/src/http'
import { registerTestIpc } from './test-ipc'
import { onTestCleanup } from './test-cleanup'
import { testHome } from './issue-tracker-doubles'

const dataDirectory = process.env.ANVIL_DATA_DIR ?? join(testHome, '.anvil-composer')

async function setup(auth = false) {
  const runtime = registerTestIpc()
  const http = createAnvilHttpServer(runtime, {
    version: 'test', requireAuthentication: auth,
    auth: { verifyPassword: async (password) => password === 'secret' }
  })
  const url = await http.listen(0)
  onTestCleanup(() => http.close())
  const headers: Record<string, string> = auth ? { Authorization: `Basic ${Buffer.from('anvil:secret').toString('base64')}` } : {}
  const rpc = async (channel: string, input?: unknown) => fetch(`${url}/rpc`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, input })
  })
  const chunk = async (importId: string, index: number, offset: number, bytes: Uint8Array) => fetch(`${url}/project-import/${importId}/${index}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Import-Offset': String(offset) }, body: Buffer.from(bytes)
  })
  await rpc('workspaces:select', 'default')
  return { url, headers, rpc, chunk }
}

test('authenticated import preserves checkout files and belongs to the initiating workspace', async () => {
  const { url, headers, rpc, chunk } = await setup(true)
  const workspace = await (await rpc('workspaces:create', `Import ${randomUUID()}`)).json() as { id: string; name: string }
  const name = `repo-${randomUUID()}`
  const entries = [
    { path: '.git', type: 'directory', size: 0 },
    { path: '.git/HEAD', type: 'file', size: 21 },
    { path: 'src', type: 'directory', size: 0 },
    { path: 'src/app.ts', type: 'file', size: 12, executable: true }
  ]
  expect((await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'projects:import-begin', input: { workspaceId: workspace.id, name, entries } }) })).status).toBe(401)
  const begun = await (await rpc('projects:import-begin', { workspaceId: workspace.id, name, entries })).json() as { importId: string }
  const destination = join(resolveWorkspaceDirectory(dataDirectory, workspace.name), 'projects', name)
  expect((await (await rpc('projects:list')).json() as Array<{ path: string }>).some((project) => project.path === destination)).toBe(false)
  expect((await fetch(`${url}/project-import/${begun.importId}/1`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Import-Offset': '0' }, body: 'ref: refs/heads/main\n'
  })).status).toBe(401)
  await rpc('workspaces:select', 'default')
  expect((await chunk(begun.importId, 1, 0, Buffer.from('ref: refs/heads/main\n'))).status).toBe(200)
  expect((await chunk(begun.importId, 3, 0, Buffer.from('hello world\n'))).status).toBe(200)
  const project = await (await rpc('projects:import-finish', begun.importId)).json() as { path: string; id: string }
  expect(project.path).toBe(destination)
  expect(readFileSync(join(destination, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
  expect(readFileSync(join(destination, 'src', 'app.ts'), 'utf8')).toBe('hello world\n')
  expect(statSync(join(destination, 'src', 'app.ts')).mode & 0o100).toBe(0o100)
  expect((await (await rpc('projects:list')).json() as Array<{ id: string }>).some((item) => item.id === project.id)).toBe(false)
  await rpc('workspaces:select', workspace.id)
  expect((await (await rpc('projects:list')).json() as Array<{ id: string }>).some((item) => item.id === project.id)).toBe(true)
  expect(headers).toHaveProperty('Authorization')
})

test('import rejects unsafe manifests and destination collisions', async () => {
  const { rpc } = await setup()
  const name = `repo-${randomUUID()}`
  for (const path of ['../escape', '/absolute', 'src/../escape', 'src\\escape', 'src/file:bad']) {
    const response = await rpc('projects:import-begin', { workspaceId: 'default', name, entries: [{ path, type: 'file', size: 1 }] })
    expect(response.status).toBe(500)
  }
  const linked = await rpc('projects:import-begin', { workspaceId: 'default', name, entries: [{ path: '.git', type: 'file', size: 12 }] })
  expect(await linked.json()).toMatchObject({ error: expect.stringContaining('Linked Git worktrees') })
  const entries = [{ path: 'readme.md', type: 'file', size: 1 }]
  expect((await rpc('projects:import-begin', { workspaceId: 'missing', name, entries })).status).toBeGreaterThanOrEqual(400)
  const begun = await (await rpc('projects:import-begin', { workspaceId: 'default', name, entries })).json() as { importId: string }
  const collision = await rpc('projects:import-begin', { workspaceId: 'default', name, entries })
  expect(await collision.json()).toMatchObject({ error: expect.stringContaining('already exists') })
  expect(existsSync(join(resolveWorkspaceDirectory(dataDirectory, 'Default'), 'projects', name))).toBe(true)
  await rpc('projects:import-cancel', begun.importId)
  expect(existsSync(join(resolveWorkspaceDirectory(dataDirectory, 'Default'), 'projects', name))).toBe(false)
})

test('incomplete and failed uploads remove partial folders', async () => {
  const { rpc, chunk } = await setup()
  const entries = [{ path: 'data.bin', type: 'file', size: 4 }]
  const name = `repo-${randomUUID()}`
  const begun = await (await rpc('projects:import-begin', { workspaceId: 'default', name, entries })).json() as { importId: string }
  const destination = join(resolveWorkspaceDirectory(dataDirectory, 'Default'), 'projects', name)
  expect((await chunk(begun.importId, 0, 0, Buffer.from('ab'))).status).toBe(200)
  expect((await rpc('projects:import-finish', begun.importId)).status).toBe(500)
  expect(existsSync(destination)).toBe(false)
  const retry = await (await rpc('projects:import-begin', { workspaceId: 'default', name, entries })).json() as { importId: string }
  expect((await chunk(retry.importId, 0, 2, Buffer.from('cd'))).status).toBe(400)
  expect(existsSync(destination)).toBe(false)
  const oversized = await (await rpc('projects:import-begin', { workspaceId: 'default', name, entries })).json() as { importId: string }
  expect((await chunk(oversized.importId, 0, 0, Buffer.alloc(4 * 1024 * 1024 + 1))).status).toBe(413)
  expect(existsSync(destination)).toBe(false)
})

test('chunk transport imports content beyond the JSON RPC body limit', async () => {
  const { rpc, chunk } = await setup()
  const name = `large-${randomUUID()}`
  const size = RPC_BODY_LIMIT + 1024
  const begun = await (await rpc('projects:import-begin', { workspaceId: 'default', name, entries: [{ path: 'large.bin', type: 'file', size }] })).json() as { importId: string }
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0x5a)
  for (let offset = 0; offset < size; offset += bytes.length) {
    const response = await chunk(begun.importId, 0, offset, bytes.subarray(0, Math.min(bytes.length, size - offset)))
    expect(response.status).toBe(200)
  }
  const project = await (await rpc('projects:import-finish', begun.importId)).json() as { path: string }
  const contents = readFileSync(join(project.path, 'large.bin'))
  expect(contents.length).toBe(size)
  expect(contents[0]).toBe(0x5a)
  expect(contents.at(-1)).toBe(0x5a)
  expect((await (await rpc('projects:list')).json() as Array<{ path: string }>).some((item) => item.path === project.path)).toBe(true)
})
