import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

if (process.versions.electron) {
  const nodePty = require('node-pty')
  if (process.platform !== 'win32') {
    const packageDirectory = dirname(require.resolve('node-pty/package.json'))
    const helper = [
      join(packageDirectory, 'build', 'Release', 'spawn-helper'),
      join(packageDirectory, 'build', 'Debug', 'spawn-helper'),
      join(packageDirectory, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    ].map((candidate) => candidate
      .replace('app.asar', 'app.asar.unpacked')
      .replace('node_modules.asar', 'node_modules.asar.unpacked'))
      .find(existsSync)
    assert(helper, `node-pty spawn helper is missing for ${process.platform}-${process.arch}`)
    chmodSync(helper, 0o755)
  }
  const marker = 'anvil-node-pty-ok'
  const executable = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `echo ${marker}`]
    : ['-c', `printf ${marker}`]
  const terminal = nodePty.spawn(executable, args, {
    cols: 80,
    rows: 24,
    env: process.env
  })
  let output = ''
  const timeout = setTimeout(() => {
    terminal.kill()
    assert.fail('node-pty did not exit within 10 seconds')
  }, 10_000)
  terminal.onData((data) => {
    output += data
  })
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout)
    assert.equal(exitCode, 0)
    assert.match(output, new RegExp(marker))
    console.log(`node-pty verified with Electron ${process.versions.electron}`)
  })
} else {
  const electronExecutable = require('electron')
  const child = spawn(electronExecutable, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit'
  })
  child.on('error', (error) => {
    throw error
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exitCode = code ?? 1
  })
}
