import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electron, expect } from './electron-fixture.mjs'

// Run after npm run build. Each restart also restarts the test-owned HTTP server.
const directory = await mkdtemp(join(tmpdir(), 'anvil-caffeine-'))
const env = { ...process.env, ANVIL_DATA_DIR: directory, ANVIL_MEMORY_BACKEND: 'disabled' }
delete env.ELECTRON_RENDERER_URL
const executablePath = process.argv.find((arg) => arg.startsWith('--executable='))?.slice('--executable='.length)
let application
async function launch(expected) {
  application = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env })
  const page = await application.firstWindow()
  await page.waitForURL(/^http:/)
  await page.waitForURL(/^http:/)
  assert.equal(new URL(page.url()).protocol, 'http:')
  const toggle = page.getByRole('checkbox', { name: 'Caffeine mode', exact: true })
  await expect(toggle).toBeChecked({ checked: expected })
  await expect.poll(() => page.evaluate(async () => (await window.anvil.settings.get()).caffeineMode)).toBe(expected)
  return { page, toggle }
}
try {
  for (const [before, after] of [[false, true], [true, false]]) {
    const { page, toggle } = await launch(before)
    await toggle.setChecked(after)
    await expect.poll(() => page.evaluate(async () => (await window.anvil.settings.get()).caffeineMode)).toBe(after)
    await application.close()
    application = undefined
  }
  await launch(false)
  console.log('Caffeine mode persists in both directions across application and server restarts.')
} finally {
  await application?.close()
  await rm(directory, { recursive: true, force: true })
}
