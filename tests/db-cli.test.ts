import { test, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

test.each([0, 7, null])('forwards Electron arguments and environment with child status %s', (status) => {
  const launcherPath = resolve('scripts/drizzle.cjs')
  const launcherSource = readFileSync(launcherPath, 'utf8')
  const projectRequire = createRequire(launcherPath)
  const exitSignal = new Error('process.exit')

  let exitCode: number | undefined
  let thrown: unknown
  try {
    runInNewContext(launcherSource, {
      __filename: launcherPath,
      process: {
        versions: {}, argv: ['node', launcherPath, 'migrate', '--help'],
        env: { TEST_ENV: 'preserved' },
        exit(code: number) { exitCode = code; throw exitSignal }
      },
      require(id: string) {
        if (id === 'electron') return '/test/electron'
        if (id === 'node:child_process') return {
          spawnSync(executable: string, args: string[], options: { env: Record<string, string> }) {
            expect(executable).toBe('/test/electron')
            expect(Array.from(args)).toStrictEqual([launcherPath, 'migrate', '--help'])
            expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
            expect(options.env.TEST_ENV).toBe('preserved')
            return { status }
          }
        }
        return projectRequire(id)
      }
    })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBe(exitSignal)
  expect(exitCode).toBe(status ?? 1)
})

test('delegates migrations to Kit and deletes only the selected development workspace database', () => {
  const launcherPath = resolve('scripts/drizzle.cjs')
  const launcherSource = readFileSync(launcherPath, 'utf8')
  const projectRequire = createRequire(launcherPath)
  const temporaryHome = mkdtempSync(join(tmpdir(), 'anvil-db-cli-'))
  try {
    const dataSource = readFileSync(resolve('scripts/app-data.cjs'), 'utf8')
    const dataModule = { exports: '' }
    runInNewContext(dataSource, {
      module: dataModule, process: { env: {} },
      require: (id: string) => id === 'node:os' ? { homedir: () => temporaryHome } : projectRequire(id)
    })
    const dataDirectory = dataModule.exports
    expect(dataDirectory).toBe(join(temporaryHome, '.anvil-composer-dev'))
    const productionFile = join(temporaryHome, '.anvil-composer', 'anvil.db')
    mkdirSync(dirname(productionFile), { recursive: true })
    writeFileSync(productionFile, 'production data')
    const databaseFile = join(dataDirectory, 'workspaces', 'Work', 'anvil.db')
    const kitPath = join(dirname(projectRequire.resolve('drizzle-kit')), 'bin.cjs')
    let kitLoaded = false
    const launcherRequire = Object.assign((id: string) => {
      if (id === './workspace-database.cjs') return () => databaseFile
      if (id === kitPath) { kitLoaded = true; return {} }
      if (id === 'node:os') return { homedir: () => temporaryHome }
      expect(id.startsWith('node:'), 'Launcher must not patch database drivers').toBeTruthy()
      return projectRequire(id)
    }, { resolve: projectRequire.resolve })
    runInNewContext(launcherSource, {
      require: launcherRequire,
      process: { versions: { electron: 'test' }, argv: ['electron', launcherPath, 'migrate'] }
    })
    expect(kitLoaded, 'Launcher delegates to the installed Drizzle Kit CLI').toBeTruthy()
    expect(existsSync(dirname(databaseFile)), 'Launcher creates the parent directory on first use').toBeTruthy()
    expect(existsSync(databaseFile), 'Only Kit should create the database').toBe(false)

    for (const suffix of ['', '-wal', '-shm']) writeFileSync(databaseFile + suffix, '')
    const unrelatedFile = join(dataDirectory, 'keep.txt')
    writeFileSync(unrelatedFile, 'keep')
    const dropSource = readFileSync(resolve('scripts/db-drop.cjs'), 'utf8')
    for (let attempt = 0; attempt < 2; attempt++) {
      runInNewContext(dropSource, {
        require: (id: string) => id === './workspace-database.cjs' ? () => databaseFile : projectRequire(id),
        console: { log() {} }
      })
    }
    for (const suffix of ['', '-wal', '-shm']) expect(existsSync(databaseFile + suffix)).toBe(false)
    expect(readFileSync(unrelatedFile, 'utf8')).toBe('keep')
    expect(readFileSync(productionFile, 'utf8')).toBe('production data')
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true })
  }
})

test('maintenance paths follow JSON selection and reject paths outside workspace folders', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-db-selection-'))
  try {
    const filename = resolve('scripts/workspace-database.cjs')
    const projectRequire = createRequire(filename)
    const scriptModule = { exports: undefined as unknown as (directory: string) => string }
    runInNewContext(readFileSync(filename, 'utf8'), { module: scriptModule, require: projectRequire, process: { env: {} } })
    const databasePath = scriptModule.exports
    expect(databasePath(directory)).toBe(join(directory, 'workspaces', 'Default', 'anvil.db'))
    const configFile = join(directory, 'config.json')
    const config = { version: 1, activeWorkspaceId: 'work', workspaces: [{ id: 'work', name: 'Work' }] }
    writeFileSync(configFile, JSON.stringify(config))
    expect(databasePath(directory)).toBe(join(directory, 'workspaces', 'Work', 'anvil.db'))
    config.workspaces[0].name = '../outside'
    writeFileSync(configFile, JSON.stringify(config))
    expect(() => databasePath(directory)).toThrow(/Invalid workspace folder/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
