import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Expose the bundled CLI without a global install or the host Node's SQLite ABI. */
export function installValenceLauncher(directory: string, executable: string, cliPath: string): void {
  mkdirSync(directory, { recursive: true })
  // Also provide the POSIX launcher on Windows for agents using Git Bash.
  const shellExecutable = process.platform === 'win32' ? executable.replaceAll('\\', '/') : executable
  const shellCliPath = process.platform === 'win32' ? cliPath.replaceAll('\\', '/') : cliPath
  writeFileSync(join(directory, 'vl'), [
    '#!/bin/sh',
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(shellExecutable)} ${shellQuote(shellCliPath)} "$@"`,
    ''
  ].join('\n'), { mode: 0o755 })
  writeFileSync(join(directory, 'vl.cmd'), [
    '@echo off', 'setlocal', 'set "ELECTRON_RUN_AS_NODE=1"',
    `"${executable.replaceAll('%', '%%')}" "${cliPath.replaceAll('%', '%%')}" %*`,
    'exit /b %errorlevel%', ''
  ].join('\r\n'))
}

/** All agent transports and their shell tools inherit this PATH at startup. */
export function exposeValenceLauncher(directory: string, environment: NodeJS.ProcessEnv = process.env): void {
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  environment[pathKey] = [directory, environment[pathKey]].filter(Boolean).join(delimiter)
}
