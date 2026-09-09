import { expect, test, vi } from 'vitest'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOpenCodeModelOutput } from '../src/main/agents/opencode-model-output'
import { onTestCleanup } from './test-cleanup'

test('preserves project context and rejects failed or oversized model output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-model-context-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const output = await readOpenCodeModelOutput(process.execPath, ['-e', `
    console.log(JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD, color: process.env.NO_COLOR }))
  `], directory)
  expect(JSON.parse(output)).toEqual({ cwd: realpathSync(directory), pwd: directory, color: '1' })
  await expect(readOpenCodeModelOutput(process.execPath, ['-e', 'process.stderr.write("Discovery unavailable"); process.exit(1)']))
    .rejects.toThrow('Discovery unavailable')
  await expect(readOpenCodeModelOutput(process.execPath, ['-e', 'require("node:fs").writeFileSync(1, Buffer.alloc(33 * 1024 * 1024))']))
    .rejects.toThrow('32 MiB output limit')
})

test('cancels model discovery while the CLI is running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-model-cancel-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const controller = new AbortController()
  onTestCleanup(() => controller.abort())
  const result = readOpenCodeModelOutput(process.execPath, ['-e', `
    require('node:fs').writeFileSync('ready', '')
    setInterval(() => {}, 1000)
  `], directory, controller.signal)
  const rejected = expect(result).rejects.toThrow(/abort/i)
  await vi.waitFor(() => expect(existsSync(join(directory, 'ready'))).toBe(true))
  controller.abort()
  await rejected
})
