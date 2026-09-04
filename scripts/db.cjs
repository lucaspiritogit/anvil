#!/usr/bin/env node
/**
 * Drop and recreate Anvil's local database.
 *
 *   npm run db:drop    delete the database files
 *   npm run db:reset   delete them, then recreate the schema
 *
 * The app applies outstanding migrations on its own at startup; these scripts
 * are for starting from an empty database, which is often what you want after
 * changing the schema during development.
 *
 * better-sqlite3 is compiled against Electron's ABI, so recreating the schema
 * has to run under Electron's Node. This file re-executes itself there when
 * started with plain node, which keeps the npm scripts platform-independent.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DB_FILE = path.join(os.homedir(), '.anvil-composer', 'anvil.db')
const SUFFIXES = ['', '-wal', '-shm']

function drop() {
  const removed = SUFFIXES.map((suffix) => DB_FILE + suffix).filter((file) => {
    if (!fs.existsSync(file)) return false
    fs.rmSync(file)
    return true
  })
  if (removed.length === 0) {
    console.log(`Nothing to drop: ${DB_FILE} does not exist.`)
    return
  }
  for (const file of removed) console.log(`Removed ${file}`)
}

function create() {
  // Build the store on the fly so the schema has exactly one definition. The
  // bundle lands inside the project so `better-sqlite3` still resolves.
  const bundle = path.join(ROOT, 'node_modules', '.anvil-db-schema.cjs')
  execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
    [
      'src/main/store.ts',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--external:better-sqlite3',
      `--outfile=${bundle}`,
      '--log-level=warning'
    ],
    { cwd: ROOT, stdio: 'inherit' }
  )
  try {
    const { Store } = require(bundle)
    new Store(DB_FILE, { migrationsFolder: path.join(ROOT, 'src', 'main', 'db', 'migrations') })
    console.log(`Created ${DB_FILE} and applied all migrations`)
  } finally {
    fs.rmSync(bundle, { force: true })
  }
}

const command = process.argv[2] ?? 'reset'
if (!['drop', 'reset'].includes(command)) {
  console.error(`Unknown command "${command}". Use "drop" or "reset".`)
  process.exit(1)
}

// Creating the schema needs Electron's Node; dropping is just file removal.
if (command === 'reset' && !process.versions.electron) {
  execFileSync(require('electron'), [__filename, command], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  process.exit(0)
}

drop()
if (command === 'reset') create()
