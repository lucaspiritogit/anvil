import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rename, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const installRoot = process.env.ANVIL_INSTALL_ROOT ?? join(homedir(), '.local', 'lib')
const service = process.env.ANVIL_SERVICE ?? 'anvil-tailscale.service'
const currentLink = join(installRoot, 'anvil-server-current')

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options })
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

try {
  if (process.platform === 'win32') throw new Error('Local server deploys are only supported on Linux and macOS.')
  if (!process.env.npm_execpath) throw new Error('Run this script through npm: npm run deploy:server')

  run(process.execPath, [process.env.npm_execpath, 'run', 'package:server'])

  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const platform = process.platform === 'darwin' ? 'macos' : process.platform
  const name = `Anvil-server-${version}-${platform}-${process.arch}`
  const archive = join(root, 'release', `${name}.tar.gz`)
  const target = join(installRoot, `anvil-server-${version}-${timestamp()}`)

  const extractDirectory = await mkdtemp(join(installRoot, '.anvil-server-extract-'))
  try {
    run('tar', ['-xzf', archive, '-C', extractDirectory])
    const [extracted] = await readdir(extractDirectory)
    if (extracted !== name) throw new Error(`Unexpected archive contents in ${archive}`)
    await rename(join(extractDirectory, name), target)
  } finally {
    await rm(extractDirectory, { recursive: true, force: true })
  }

  const nextLink = `${currentLink}.next`
  await rm(nextLink, { force: true })
  await symlink(target, nextLink)
  await rename(nextLink, currentLink)
  console.log(`Installed ${target}`)

  run('systemctl', ['--user', 'restart', service])
  run('systemctl', ['--user', '--no-pager', '--lines=0', 'status', service])
  console.log(`Restarted ${service} on Anvil ${version}.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
