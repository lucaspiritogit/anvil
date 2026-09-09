// node-pty ships `spawn-helper` inside its prebuilds, and the executable bit is
// lost on some installs (npm on Windows, CI caches, `npm ci` restores). Without
// it, pty.fork() dies with "posix_spawnp failed" on macOS/Linux. Restore it.
const fs = require('node:fs')
const path = require('node:path')

if (process.platform === 'win32') process.exit(0)

const root = path.join(__dirname, '..', 'node_modules', 'node-pty')
const candidates = []

const prebuilds = path.join(root, 'prebuilds')
if (fs.existsSync(prebuilds)) {
  for (const dir of fs.readdirSync(prebuilds)) {
    candidates.push(path.join(prebuilds, dir, 'spawn-helper'))
  }
}
candidates.push(path.join(root, 'build', 'Release', 'spawn-helper'))

for (const file of candidates) {
  if (!fs.existsSync(file)) continue
  const mode = fs.statSync(file).mode
  if (mode & 0o111) continue
  fs.chmodSync(file, mode | 0o755)
  console.log(`> Restored +x on ${path.relative(path.join(__dirname, '..'), file)}`)
}
