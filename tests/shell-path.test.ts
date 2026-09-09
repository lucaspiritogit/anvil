import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreShellPath } from '../src/main/shell-path'
import { resolveCommand } from '../src/main/agents/resolve'
import { exposeValenceLauncher, installValenceLauncher } from '../src/main/valence/launcher'

test('leaves PATH unchanged outside macOS', async () => {
  const untouched = { PATH: '/test/bin', SHELL: '/missing-shell' }
  await restoreShellPath(untouched, 'win32')
  await restoreShellPath(untouched, 'linux')
  expect(untouched.PATH).toBe('/test/bin')
})

test.runIf(process.platform === 'darwin')('restores login and interactive PATH, launches agents and tolerates shell failures', async () => {

  const directory = await mkdtemp(join(tmpdir(), 'anvil shell path '))
  const originalPath = process.env.PATH
  try {
    const profileBin = join(directory, 'profile bin')
    const interactiveBin = join(directory, 'interactive bin')
    await mkdir(profileBin)
    await mkdir(interactiveBin)
    await symlink(process.env.ANVIL_TEST_NODE!, join(profileBin, 'node'))
    for (const [command, bin] of [['codex', profileBin], ['opencode', interactiveBin]]) {
      await writeFile(join(bin, command), '#!/usr/bin/env node\nconsole.log("agent started")\n', { mode: 0o755 })
    }
    await writeFile(join(directory, '.zprofile'), 'export PATH="$ZDOTDIR/profile bin:$PATH"\n')
    await writeFile(join(directory, '.zshrc'), 'echo "shell startup banner"\nexport PATH="$ZDOTDIR/interactive bin:$PATH"\n')
    const environment = {
      ...process.env, SHELL: '/bin/zsh', ZDOTDIR: directory,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/inherited-tool/bin'
    }
    process.env.PATH = environment.PATH
    expect(resolveCommand('codex')).toBe(null)
    expect(resolveCommand('opencode')).toBe(null)

    await restoreShellPath(environment)
    exposeValenceLauncher(join(directory, 'valence'), environment)
    process.env.PATH = environment.PATH
    expect(environment.PATH.split(':')[0]).toBe(join(directory, 'valence'))
    expect(environment.PATH.split(':').includes('/inherited-tool/bin')).toBeTruthy()
    for (const command of ['codex', 'opencode']) {
      const resolved = resolveCommand(command)
      expect(resolved, `${command} is not installed or not on PATH after GUI startup`).toBeTruthy()
      const result = spawnSync(resolved!.command, resolved!.prefixArgs, { env: environment, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('agent started')
    }

    const brokenShell = { ...environment, SHELL: '/anvil-missing-shell' }
    await restoreShellPath(brokenShell)
    expect(brokenShell.PATH).toBe(environment.PATH)
    await writeFile(join(directory, '.zshrc'), 'exit 0\n')
    const emptyShell = { ...environment }
    await restoreShellPath(emptyShell)
    expect(emptyShell.PATH).toBe(environment.PATH)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(directory, { recursive: true, force: true })
  }
})

test('Windows launcher preserves percent literals, disables delayed expansion and forwards arguments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-launcher-'))
  try {
    installValenceLauncher(directory, 'C:\\App 100%\\electron.exe', 'C:\\App!\\cli.js', 'C:\\Profile %user%!\\anvil.db')
    const cmd = readFileSync(join(directory, 'vl.cmd'), 'utf8')
    expect(cmd).toContain('setlocal DisableDelayedExpansion')
    expect(cmd).toContain('set "ANVIL_DATABASE_PATH=C:\\Profile %%user%%!\\anvil.db"')
    expect(cmd).toContain('"C:\\App 100%%\\electron.exe" "C:\\App!\\cli.js" %*')
    expect(cmd).toContain('exit /b %errorlevel%')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
