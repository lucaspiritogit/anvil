import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import electron from 'electron'

const directory = await mkdtemp(join(tmpdir(), 'anvil-issue-tracker-suite-'))
try {
  for (const suite of ['issue-tracker', 'issue-tracker-git']) {
  const outfile = join(directory, 'issue-tracker-test.cjs')
  await build({
    entryPoints: [`tests/${suite}.test.ts`], outfile, bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', plugins: [{
      name: 'issue-tracker-test-doubles',
      setup(build) {
        build.onResolve({ filter: /^(electron|\.\/agents\/(runner|models)|\.\/git-delivery|\.\/terminal|\.\/memory\/project-memory)$/ }, (args) => {
          if (suite === 'issue-tracker-git' && args.path === './git-delivery') return undefined
          return { path: resolve('tests/issue-tracker-doubles.ts') }
        })
      }
    }]
  })
  const result = spawnSync(electron, [outfile], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') }
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
  if (process.exitCode) break
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
