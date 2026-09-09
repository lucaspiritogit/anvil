#!/usr/bin/env node
// Quit Anvil before deleting its SQLite database and WAL sidecar files.
const { existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const databaseFile = join(require('./app-data.cjs'), 'anvil.db')
for (const suffix of ['', '-wal', '-shm']) {
  const filename = databaseFile + suffix
  if (!existsSync(filename)) continue
  rmSync(filename)
  console.log(`Removed ${filename}`)
}
