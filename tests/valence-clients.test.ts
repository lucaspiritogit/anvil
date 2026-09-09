import { expect, test } from 'vitest'
import { runElectronFixture } from './electron-fixture'

test('Anvil-owned vl shares live storage without recovery, isolates profiles and atomically claims', async () => {
  const output = await runElectronFixture('tests/fixtures/valence-clients.ts')
  expect(output).toContain('Valence clients passed: Electron SQLite, shared storage, profiles, atomic claims')
})
