import { expect, test, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dialog } from './issue-tracker-doubles'
import { pickProjectFolder, readProjectFile, releaseProjectFolder } from '../apps/desktop/src/main/project-folder'
import { onTestCleanup } from './test-cleanup'

test('desktop folder dialog links the selected folder in place for the local server', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-local-project-')))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  Object.assign(dialog, { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [root] })) })
  expect(await pickProjectFolder(true)).toEqual({ name: root.split('/').at(-1), path: root })
})

test('desktop folder dialog reads the selected checkout in bounded chunks and releases it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-local-project-'))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
  Object.assign(dialog, { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [root] })) })
  const chosen = await pickProjectFolder(false)
  if (!chosen || !('token' in chosen)) throw new Error('Expected an upload selection')
  expect(chosen).toMatchObject({ name: root.split('/').at(-1), entries: [
    { path: '.git', type: 'directory' }, { path: '.git/HEAD', type: 'file' }
  ] })
  expect((dialog as { showOpenDialog: ReturnType<typeof vi.fn> }).showOpenDialog).toHaveBeenCalledWith({ title: 'Add project from disk', properties: ['openDirectory'] })
  const bytes = await readProjectFile({ token: chosen.token, index: 1, offset: 5, length: 4 })
  expect(new TextDecoder().decode(bytes)).toBe('refs')
  expect(await readProjectFile({ token: chosen.token, index: 0, offset: 0, length: 1 }).catch((error: Error) => error.message)).toBe('Invalid project file read')
  releaseProjectFolder(chosen.token)
  await expect(readProjectFile({ token: chosen.token, index: 1, offset: 0, length: 1 })).rejects.toThrow('Invalid project file read')
})

test('desktop folder dialog cancellation returns no selection', async () => {
  Object.assign(dialog, { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) })
  expect(await pickProjectFolder(false)).toBeNull()
  expect(await pickProjectFolder(true)).toBeNull()
})

test('desktop folder upload skips symbolic links and dependency folders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-linked-project-'))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'README.md'), 'readme')
  symlinkSync(join(root, 'README.md'), join(root, 'linked'))
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'index.js'), '')
  Object.assign(dialog, { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [root] })) })
  expect(await pickProjectFolder(false)).toMatchObject({ entries: [{ path: 'README.md', type: 'file' }] })
})
