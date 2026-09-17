import { chmod, copyFile, cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform
const name = `Anvil-server-${packageJson.version}-${platform}-${process.arch}`
const stagingRoot = join(root, 'release', 'server')
const stagingDirectory = join(stagingRoot, name)
const appDirectory = join(stagingDirectory, 'app')
const runtimeDirectory = join(stagingDirectory, 'runtime')

await rm(stagingDirectory, { recursive: true, force: true })
await mkdir(appDirectory, { recursive: true })
await mkdir(runtimeDirectory, { recursive: true })
await cp(join(root, 'out', 'server'), join(appDirectory, 'server'), { recursive: true })
await cp(join(root, 'out', 'renderer'), join(appDirectory, 'renderer'), { recursive: true })
const serverPackage = { ...packageJson, scripts: {} }
await writeFile(join(appDirectory, 'package.json'), `${JSON.stringify(serverPackage, null, 2)}\n`)
await copyFile(join(root, 'package-lock.json'), join(appDirectory, 'package-lock.json'))
await copyFile(join(root, 'LICENSE'), join(stagingDirectory, 'LICENSE'))

const npm = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'npm'
const npmArguments = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd'] : []
run(npm, [...npmArguments, 'ci', '--omit=dev', '--no-audit', '--no-fund'], appDirectory)

const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const nodeExecutable = await realpath(process.execPath)
await copyFile(nodeExecutable, join(runtimeDirectory, nodeName))
if (process.platform !== 'win32') await chmod(join(runtimeDirectory, nodeName), 0o755)
run(join(runtimeDirectory, nodeName), [
  '-e',
  "require('argon2'); require('node-pty'); const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.prepare('SELECT 1').get(); db.close()"
], appDirectory)

const nodeRoot = process.platform === 'win32' ? dirname(nodeExecutable) : resolve(dirname(nodeExecutable), '..')
try {
  await copyFile(join(nodeRoot, 'LICENSE'), join(runtimeDirectory, 'NODE-LICENSE'))
} catch {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`)
  if (!response.ok) throw new Error(`Could not download the Node.js ${process.versions.node} license`)
  await writeFile(join(runtimeDirectory, 'NODE-LICENSE'), await response.text())
}

if (process.platform === 'win32') {
  await writeFile(join(stagingDirectory, 'anvil-server.cmd'), [
    '@echo off',
    'set "ANVIL_PACKAGED=1"',
    '"%~dp0runtime\\node.exe" "%~dp0app\\server\\index.js" --headless %*',
    ''
  ].join('\r\n'))
} else {
  const launcher = join(stagingDirectory, 'anvil-server')
  await writeFile(launcher, [
    '#!/bin/sh',
    'set -eu',
    'root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'export ANVIL_PACKAGED=1',
    'exec "$root/runtime/node" "$root/app/server/index.js" --headless "$@"',
    ''
  ].join('\n'))
  await chmod(launcher, 0o755)
}

const archive = join(root, 'release', `${name}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`)
await rm(archive, { force: true })
const archiveArguments = process.platform === 'win32'
  ? ['-a', '-cf', archive, '-C', stagingRoot, name]
  : ['-czf', archive, '-C', stagingRoot, name]
run('tar', archiveArguments, root)
await rm(stagingDirectory, { recursive: true, force: true })
console.log(`Packaged ${archive}`)

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}
