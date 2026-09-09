import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCommand } from './resolve'
import { OPEN_CODE_SUPPORTED_VERSION } from './opencode-workspace'

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024

/** OpenCode can exit before piped stdout drains. A regular file preserves the full catalogue. */
export async function readOpenCodeModelOutput(command: string, args: string[], cwd?: string, signal?: AbortSignal, environment?: Readonly<NodeJS.ProcessEnv>): Promise<string> {
  const resolved = resolveCommand(command)
  if (!resolved) throw new Error(`"${command}" is not installed or not on PATH`)
  signal?.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'anvil-opencode-models-'))
  try {
    const path = join(directory, 'models.txt')
    const output = await open(path, 'w', 0o600)
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(resolved.command, [...resolved.prefixArgs, ...args], {
          cwd, signal, timeout: 20_000, killSignal: 'SIGKILL',
          shell: resolved.viaShell, windowsHide: true,
          stdio: ['ignore', output.fd, 'pipe'],
          env: { ...(environment ?? process.env), ...(cwd ? { PWD: cwd } : {}), NO_COLOR: '1', FORCE_COLOR: '0' }
        })
        let failure: Error | undefined
        const errors: Buffer[] = []
        let errorBytes = 0
        child.stderr!.on('data', (chunk: Buffer) => {
          const retained = chunk.subarray(0, Math.max(0, MAX_ERROR_BYTES - errorBytes))
          if (retained.length) errors.push(retained)
          errorBytes += retained.length
        })
        child.once('error', (error) => { failure = error })
        child.once('close', (code, exitSignal) => {
          if (failure) reject(failure)
          else if (code !== 0) reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `OpenCode model discovery exited with ${exitSignal ?? code}`))
          else resolve()
        })
      })
      if ((await output.stat()).size > MAX_OUTPUT_BYTES) throw new Error('OpenCode model catalogue exceeds the 32 MiB output limit')
    } finally {
      await output.close()
    }
    return await readFile(path, 'utf8')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Refuse unverified CLI releases before they can load a workspace account. */
export async function verifyWorkspaceOpenCode(command: string, cwd: string, environment: Readonly<NodeJS.ProcessEnv>, signal?: AbortSignal): Promise<void> {
  const version = (await readOpenCodeModelOutput(command, ['--version'], cwd, signal, environment)).trim()
  if (version !== OPEN_CODE_SUPPORTED_VERSION) {
    throw new Error(`OpenCode ${version || 'unknown'} has not been verified for workspace isolation. Anvil currently supports OpenCode ${OPEN_CODE_SUPPORTED_VERSION}.`)
  }
}
