import { expect, test, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dialog } from './issue-tracker-doubles'
import { pickProjectFolder, readProjectFile, releaseProjectFolder } from '../apps/desktop/src/main/project-folder'
import { onTestCleanup } from './test-cleanup'

test('desktop folder dialog reads the selected checkout in bounded chunks and releases it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-local-project-'))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
  Object.assign(dialog, { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [root] })) })
  const chosen = await pickProjectFolder()
  expect(chosen).toMatchObject({ name: root.split('/').at(-1), entries: [
    { path: '.git', type: 'directory' }, { path: '.git/HEAD', type: 'file' }
  ] })
  expect((dialog as { showOpenDialog: ReturnType<typeof vi.fn> }).showOpenDialog).toHaveBeenCalledWith({ title: 'Add project from disk', properties: ['openDirectory'] })
  const bytes = await readProjectFile({ token: chosen!.token, index: 1, offset: 5, length: 4 })
  expect(new TextDecoder().decode(bytes)).toBe('refs')
  expect(await readProjectFile({ token: chosen!.token, index: 0, offset: 0, length: 1 }).catch((error: Error) => error.message)).toBe('Invalid project file read')
  releaseProjectFolder(chosen!.token)
  await expect(readProjectFile({ token: chosen!.token, index: 1, offset: 0, length: 1 })).rejects.toThrow('Invalid project file read')
})

test('desktop folder dialog cancellation and linked files do not create a selection', async () => {
  Object.assign(dialog, { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) })
  expect(await pickProjectFolder()).toBeNull()
  const root = mkdtempSync(join(tmpdir(), 'anvil-linked-project-'))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'README.md'), 'readme')
  symlinkSync(join(root, 'README.md'), join(root, 'linked'))
  Object.assign(dialog, { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [root] })) })
  await expect(pickProjectFolder()).rejects.toThrow('symbolic link')
})
