import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export default function prepareIntegrationTests(): void {
  execFileSync(process.execPath, [resolve('scripts/prepare-vitest-native.mjs')], { stdio: 'inherit' })
}
