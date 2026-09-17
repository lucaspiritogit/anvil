const { chmodSync, existsSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform === 'darwin') {
  const helper = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  if (!existsSync(helper)) {
    throw new Error(`node-pty does not include a spawn helper for ${process.platform}-${process.arch}`)
  }
  chmodSync(helper, 0o755)
}
