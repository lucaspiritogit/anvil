import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

function main(): void {
  const launcherPath = resolve('scripts/drizzle.cjs')
  const launcherSource = readFileSync(launcherPath, 'utf8')
  const projectRequire = createRequire(launcherPath)
  const temporaryHome = mkdtempSync(join(tmpdir(), 'anvil-db-cli-'))
  const exitSignal = new Error('process.exit')

  try {
    for (const status of [0, 7, null]) {
      let exitCode: number | undefined
      assert.throws(() => runInNewContext(launcherSource, {
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
              assert.equal(executable, '/test/electron')
              assert.deepEqual(Array.from(args), [launcherPath, 'migrate', '--help'])
              assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
              assert.equal(options.env.TEST_ENV, 'preserved')
              return { status }
            }
          }
          return projectRequire(id)
        }
      }), (error) => error === exitSignal)
      assert.equal(exitCode, status ?? 1)
    }

    const kitPath = join(dirname(projectRequire.resolve('drizzle-kit')), 'bin.cjs')
    let kitLoaded = false
    const launcherRequire = Object.assign((id: string) => {
      if (id === kitPath) { kitLoaded = true; return {} }
      if (id === 'node:os') return { homedir: () => temporaryHome }
      assert.ok(id.startsWith('node:'), 'Launcher must not patch database drivers')
      return projectRequire(id)
    }, { resolve: projectRequire.resolve })
    runInNewContext(launcherSource, {
      require: launcherRequire,
      process: { versions: { electron: 'test' }, argv: ['electron', launcherPath, 'migrate'] }
    })
    assert.ok(kitLoaded, 'Launcher delegates to the installed Drizzle Kit CLI')
    const databaseFile = join(temporaryHome, '.anvil-composer', 'anvil.db')
    assert.ok(existsSync(dirname(databaseFile)), 'Launcher creates the parent directory on first use')
    assert.equal(existsSync(databaseFile), false, 'Only Kit should create the database')

    for (const suffix of ['', '-wal', '-shm']) writeFileSync(databaseFile + suffix, '')
    const unrelatedFile = join(temporaryHome, '.anvil-composer', 'keep.txt')
    writeFileSync(unrelatedFile, 'keep')
    const dropSource = readFileSync(resolve('scripts/db-drop.cjs'), 'utf8')
    for (let attempt = 0; attempt < 2; attempt++) {
      runInNewContext(dropSource, {
        require: (id: string) => id === 'node:os' ? { homedir: () => temporaryHome } : projectRequire(id),
        console: { log() {} }
      })
    }
    for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(databaseFile + suffix), false)
    assert.equal(readFileSync(unrelatedFile, 'utf8'), 'keep')
    console.log('Database CLI tests passed: Electron launch, exit status, Drizzle delegation, and isolated file deletion.')
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true })
  }
}

main()
