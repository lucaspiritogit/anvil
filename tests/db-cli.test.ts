import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { workspaceDatabase, selectedWorkspaceDirectory } from '../src/shared/app-data'

const require = createRequire(import.meta.url)
const { dropDatabase } = require('../scripts/maintenance.cjs') as { dropDatabase(): void }

test('maintenance follows workspace selection and rejects unsafe folder names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-db-selection-'))
  const previous = process.env.ANVIL_DATABASE_PATH
  delete process.env.ANVIL_DATABASE_PATH
  try {
    expect(workspaceDatabase(directory)).toBe(join(directory, 'workspaces', 'Default', 'anvil.db'))
    const config = { version: 1, activeWorkspaceId: 'work', workspaces: [{ id: 'work', name: 'Work' }] }
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config))
    expect(selectedWorkspaceDirectory(directory)).toBe(join(directory, 'workspaces', 'Work'))
    expect(workspaceDatabase(directory)).toBe(join(directory, 'workspaces', 'Work', 'anvil.db'))
    for (const name of ['../escape', '.', 'CON', 'Work.']) {
      config.workspaces[0].name = name
      writeFileSync(join(directory, 'config.json'), JSON.stringify(config))
      expect(() => workspaceDatabase(directory)).toThrow()
    }
    process.env.ANVIL_DATABASE_PATH = 'relative.db'
    expect(() => workspaceDatabase(directory)).toThrow()
  } finally {
    if (previous === undefined) delete process.env.ANVIL_DATABASE_PATH
    else process.env.ANVIL_DATABASE_PATH = previous
    rmSync(directory, { recursive: true, force: true })
  }
})

test('drop removes only the selected database and SQLite sidecars', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-db-drop-'))
  const previous = process.env.ANVIL_DATABASE_PATH
  const database = join(directory, 'workspaces', 'Work', 'anvil.db')
  try {
    mkdirSync(dirname(database), { recursive: true })
    process.env.ANVIL_DATABASE_PATH = database
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(database + suffix, '')
    const keep = join(directory, 'keep.db')
    writeFileSync(keep, 'unrelated data')
    dropDatabase()
    dropDatabase()
    for (const suffix of ['', '-wal', '-shm']) expect(existsSync(database + suffix)).toBe(false)
    expect(existsSync(keep)).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.ANVIL_DATABASE_PATH
    else process.env.ANVIL_DATABASE_PATH = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
