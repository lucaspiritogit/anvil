#!/usr/bin/env node
// Quit Anvil before deleting the selected workspace database and WAL sidecar files.
const { existsSync, rmSync } = require('node:fs')

const databaseFile = require('./workspace-database.cjs')()
for (const suffix of ['', '-wal', '-shm']) {
  const filename = databaseFile + suffix
  if (!existsSync(filename)) continue
  rmSync(filename)
  console.log(`Removed ${filename}`)
}
