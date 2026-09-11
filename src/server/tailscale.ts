import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { closeProcessTree } from './process-tree'

interface TailscaleStatus {
  BackendState?: string
  Self?: { DNSName?: string }
}

interface ServeConfig {
  TCP?: Record<string, unknown>
  Foreground?: Record<string, ServeConfig>
}

function parseCommandJson(output: string, command: string): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    // The macOS CLI can print a startup failure to stdout and still exit zero.
    const details = output.trim().slice(0, 2048) || 'Tailscale returned an empty response.'
    throw new Error(`Could not read Tailscale ${command}. ${details}`)
  }
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Could not read Tailscale ${command}: expected a JSON object.`)
  }
  return value as Record<string, unknown>
}

export interface TailscaleConnection {
  status(): { tailscaleHttps: boolean, tailscaleUrl?: string, tailscaleSetupUrl?: string }
  configure(enabled: boolean): Promise<void>
  onStopped(listener: (message: string) => void): () => void
  close(): Promise<void>
}

async function findTailscale(): Promise<string> {
  const executable = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'
  const candidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, executable))
  if (process.platform === 'darwin') {
    // The macOS CLI shim can be a shell script that does not forward signals.
    candidates.unshift('/Applications/Tailscale.app/Contents/MacOS/Tailscale', join(homedir(), 'Applications/Tailscale.app/Contents/MacOS/Tailscale'))
  }
  if (process.platform === 'win32' && process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, 'Tailscale', executable))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch { /* Try the next installed location. */ }
  }
  throw new Error('Install Tailscale on this computer and sign in, then enable Tailscale HTTPS again.')
}

function startCommand(binary: string, args: string[]) {
  return spawn(binary, args, {
    // The macOS app chooses GUI mode when launched without terminal variables.
    // Force CLI mode for both status requests and the long-running Serve command.
    env: process.platform === 'darwin' ? { ...process.env, TAILSCALE_BE_CLI: '1' } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  })
}

function stopCommand(child: ChildProcess, closed: Promise<void>): Promise<void> {
  return closeProcessTree(child.pid, closed, (force) => {
    if (!child.pid) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', () => { child.kill('SIGKILL') })
      return
    }
    try {
      // Signal the group even when a wrapper exited and its children hold the pipes.
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  })
}

async function runCommand(binary: string, args: string[]): Promise<string> {
  const child = startCommand(binary, args)
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  let output = ''
  let errors = ''
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<string>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Tailscale did not respond within 10 seconds.')), 10_000)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output.length > 1024 * 1024) reject(new Error('Tailscale returned too much output.'))
      })
      child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-8192) })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) resolve(output)
        else reject(new Error(errors.trim() || output.trim().slice(0, 2048) || `Tailscale exited with code ${code}.`))
      })
    })
  } catch (error) {
    await stopCommand(child, closed)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/** Foreground Serve belongs to this process; stopping it removes only its own route. */
export function createTailscaleConnection(proxy: {
  start(origin: string): Promise<string>
  stop(): Promise<void>
}): TailscaleConnection {
  let child: ChildProcess | undefined
  let childClosed: Promise<void> | undefined
  let url: string | undefined
  let setupUrl: string | undefined
  let disposed = false
  const listeners = new Set<(message: string) => void>()

  const stop = async (): Promise<void> => {
    const active = child
    const closed = childClosed
    child = undefined
    childClosed = undefined
    url = undefined
    // Close the authenticated listener even if the Tailscale daemon is unavailable.
    await Promise.all([
      proxy.stop(),
      active && closed ? stopCommand(active, closed) : Promise.resolve()
    ])
  }

  return {
    status: () => ({
      tailscaleHttps: url !== undefined,
      ...(url ? { tailscaleUrl: url } : {}),
      ...(setupUrl ? { tailscaleSetupUrl: setupUrl } : {})
    }),
    onStopped(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async close() {
      disposed = true
      await stop()
    },
    async configure(enabled) {
      setupUrl = undefined
      if (!enabled) return stop()
      if (disposed) throw new Error('Anvil server is closing.')
      if (url) return
      const binary = await findTailscale()
      const run = async (args: string[]): Promise<string> => {
        try {
          return await runCommand(binary, args)
        } catch (error) {
          const details = error instanceof Error ? error.message : 'The Tailscale command failed.'
          throw new Error(`Could not contact Tailscale. ${details}`)
        }
      }
      const status = parseCommandJson(await run(['status', '--json']), 'status') as TailscaleStatus | null
      if (!status || typeof status.BackendState !== 'string') {
        throw new Error('Tailscale returned status without a connection state.')
      }
      if (status.BackendState !== 'Running') throw new Error('Connect Tailscale on this computer, then enable Tailscale HTTPS again.')
      const hostname = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : undefined
      if (!hostname || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/i.test(hostname)) {
        throw new Error('Tailscale has no HTTPS hostname. Enable MagicDNS and HTTPS certificates in your Tailscale admin console.')
      }
      const config = parseCommandJson(await run(['serve', 'status', '--json']), 'Serve status') as ServeConfig | null
      if (config?.TCP?.['443'] || Object.values(config?.Foreground ?? {}).some((entry) => entry.TCP?.['443'])) {
        throw new Error('Tailscale port 443 is already serving another application. Free that port before enabling Anvil HTTPS.')
      }
      const origin = `https://${hostname}`
      if (disposed) throw new Error('Anvil server is closing.')
      try {
        const target = await proxy.start(origin)
        if (disposed) throw new Error('Anvil server is closing.')
        const serving = startCommand(binary, ['serve', '--https=443', '--yes', target])
        child = serving
        childClosed = new Promise((resolve) => serving.once('close', () => resolve()))
        let output = ''
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Tailscale HTTPS setup did not finish. Enable HTTPS in your Tailscale admin console, then retry. ${output.trim()}`))
          }, 20_000)
          const collect = (chunk: Buffer): void => {
            output = (output + chunk.toString()).slice(-8192)
            const startupFailure = output.match(/The Tailscale (?:CLI|GUI) failed to start:[^\r\n]*(?:\r?\n)/)?.[0]
            if (startupFailure) {
              clearTimeout(timeout)
              reject(new Error(startupFailure.trim()))
              return
            }
            // Tailscale waits for browser approval even with --yes. Return that
            // step to the user instead of leaving the connection transition pending.
            const approvalLink = output.match(/https:\/\/(?:login|admin)\.tailscale\.com\/[^\s]+(?=\s)/)?.[0]
            if (approvalLink) {
              setupUrl = approvalLink
              clearTimeout(timeout)
              reject(new Error('Tailscale needs HTTPS approval. Open the setup link below, complete setup, then enable Tailscale HTTPS again.'))
              return
            }
            if (output.includes('Press Ctrl+C to exit.')) {
              clearTimeout(timeout)
              resolve()
            }
          }
          serving.stdout.on('data', collect)
          serving.stderr.on('data', collect)
          serving.once('error', (error) => { clearTimeout(timeout); reject(error) })
          serving.once('close', () => {
            clearTimeout(timeout)
            const message = `Tailscale HTTPS stopped. ${output.trim()}`
            reject(new Error(message))
            if (child !== serving) return
            const wasReady = url !== undefined
            child = undefined
            url = undefined
            void proxy.stop().catch((error) => console.error('Could not close Tailscale listener:', error))
            if (wasReady) for (const listener of listeners) listener(message)
          })
        })
        if (disposed || child !== serving) throw new Error('Tailscale HTTPS stopped during setup.')
        url = origin
      } catch (error) {
        await stop()
        throw error
      }
    }
  }
}
