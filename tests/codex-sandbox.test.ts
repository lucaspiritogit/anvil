import { onTestCleanup } from './test-cleanup'
import { expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAgentServer } from '../src/main/agents/agent-server-process'
import { codexSandboxPolicy } from '../src/main/agents/codex-sandbox'

test('allows unrestricted commands with the Codex sandbox policy', async () => {
  const policy = codexSandboxPolicy()
  expect(policy).toStrictEqual({ type: 'dangerFullAccess' })

  // Opt in to exercising the installed app-server without calling a model.
  if (process.env.ANVIL_TEST_CODEX_SANDBOX === '1') {
    const directory = await mkdtemp(join(tmpdir(), 'anvil-codex-permissions-'))
    onTestCleanup(() => rm(directory, { recursive: true, force: true }))
    try {
      const home = join(directory, 'codex-home')
      const workspace = join(directory, 'workspace')
      await mkdir(home)
      await mkdir(workspace)
      const script = join(workspace, 'check.cjs')
      await writeFile(script, `
const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
writeFileSync(${JSON.stringify(join(directory, 'outside-workspace'))}, 'allowed')
async function main() {
  if (process.env.ANVIL_TEST_CODEX_BROWSER === '1') {
    const { chromium } = require(${JSON.stringify(createRequire(import.meta.url).resolve('@playwright/test'))})
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent('<h1>Browser validation passed</h1>')
      assert.equal(await page.locator('h1').textContent(), 'Browser validation passed')
      console.log('Chromium launch and Playwright assertion passed')
    } finally {
      await browser.close()
    }
  }
  console.log('Unrestricted command execution passed')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
`)
      const server = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        cwd: workspace, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32'
      })
      const closed = new Promise<void>((resolve) => server.once('close', () => resolve()))
      let closing: Promise<void> | undefined
      const close = (): Promise<void> => closing ??= closeAgentServer(server, closed)
      onTestCleanup(close)
      try {
        const response = await new Promise<any>((resolveResponse, rejectResponse) => {
          server.on('error', rejectResponse)
          server.on('exit', () => rejectResponse(new Error('Codex server exited')))
          const lines = createInterface({ input: server.stdout })
          onTestCleanup(() => lines.close())
          lines.on('line', (line) => {
            const message = JSON.parse(line)
            if (message.id === 1) {
              server.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
              server.stdin.write(`${JSON.stringify({ id: 2, method: 'command/exec', params: {
                command: [process.env.ANVIL_TEST_NODE ?? process.execPath, script], cwd: workspace, sandboxPolicy: policy
              } })}\n`)
            }
            if (message.id === 2) {
              lines.close()
              resolveResponse(message)
            }
          })
          server.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'anvil-test', version: '0.1.0' } } })}\n`)
        })
        expect(response.error, JSON.stringify(response.error)).toBe(undefined)
        expect(response.result.exitCode, response.result.stderr).toBe(0)
        expect(response.result.stdout).toMatch(/Unrestricted command execution passed/)
        if (process.env.ANVIL_TEST_CODEX_BROWSER === '1') {
          expect(response.result.stdout).toMatch(/Chromium launch and Playwright assertion passed/)
        }
        console.log(response.result.stdout.trim())
      } finally {
        await close()
        server.removeAllListeners()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}, 30_000)
