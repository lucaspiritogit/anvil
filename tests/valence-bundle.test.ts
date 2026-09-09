import { expect, test } from 'vitest'
import { runElectronFixture } from './electron-fixture'

test('packaged Valence ASAR library and CLI share real SQLite storage', async () => {
  const output = await runElectronFixture('tests/fixtures/valence-bundle.ts')
  expect(output).toContain('Valence bundle passed: ASAR, native SQLite')
})
