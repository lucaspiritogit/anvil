#!/usr/bin/env node
// Drizzle Kit must use Electron's ABI for the rebuilt better-sqlite3 module.
const { spawnSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const { dirname, join } = require('node:path')

if (!process.versions.electron) {
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

if (process.argv[2] === 'migrate') {
  mkdirSync(dirname(require('./workspace-database.cjs')()), { recursive: true })
}

require(join(dirname(require.resolve('drizzle-kit')), 'bin.cjs'))
