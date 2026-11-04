import { expect, test } from 'vitest'
import { patchFileStats, taskRiskFlags } from '@anvil/protocol/task-risk'

const file = (path: string, body: string, header = 'index 1111111..2222222 100644'): string =>
  `diff --git a/${path} b/${path}\n${header}\n--- a/${path}\n+++ b/${path}\n${body}`

test('counts additions, deletions and deleted files per path', () => {
  const patch = file('src/a.ts', '@@ -1 +1,2 @@\n-old\n+new\n+more\n') + file('src/gone.ts', '@@ -1 +0,0 @@\n-gone\n', 'deleted file mode 100644')
  expect(patchFileStats(patch)).toEqual([
    { path: 'src/a.ts', additions: 2, deletions: 1, deleted: false },
    { path: 'src/gone.ts', additions: 0, deletions: 1, deleted: true }
  ])
})

test('flags sensitive files from most to least sensitive', () => {
  const patch = [
    file('package-lock.json', '+x\n'),
    file('db/migrations/001_init.sql', '+create table t ();\n'),
    file('.env.production', '+KEY=1\n'),
    file('.env.example', '+KEY=\n'),
    file('.github/workflows/ci.yml', '+on: push\n'),
    file('src/app.ts', '+ok\n')
  ].join('')
  expect(taskRiskFlags(patch).map((flag) => [flag.kind, flag.files])).toEqual([
    ['secrets', ['.env.production']],
    ['migration', ['db/migrations/001_init.sql']],
    ['ci', ['.github/workflows/ci.yml']],
    ['lockfile', ['package-lock.json']]
  ])
})

test('flags large deletions and files outside the planned set', () => {
  const removed = `@@ -1,200 +0,0 @@\n${'-line\n'.repeat(200)}`
  const patch = file('src/big.ts', removed) + file('src/planned.ts', '+x\n') + file('src/extra.ts', '+y\n') + file('package-lock.json', '+z\n')
  const flags = taskRiskFlags(patch, ['src/planned.ts', './src/big.ts'])
  expect(flags.find((flag) => flag.kind === 'deletion')?.files).toEqual(['src/big.ts'])
  expect(flags.find((flag) => flag.kind === 'unexpected')?.files).toEqual(['src/extra.ts'])
})

test('reports nothing for an ordinary change without a plan', () => {
  expect(taskRiskFlags(file('src/app.ts', '+ok\n'))).toEqual([])
})
