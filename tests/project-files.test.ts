import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { listProjectFiles, PROJECT_FILE_LIMITS, projectFileParts } from '../src/server/project-files'
import { onTestCleanup } from './test-cleanup'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, opendir: vi.fn(actual.opendir) }
})

function fixture(git = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-project-files-')))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  const project = { id: 'selected-project', path: root }
  const command = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  if (git) command('init', '-q', '-b', 'main')
  const write = (path: string, content = 'Contents must never be returned'): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return { root, project, command, write }
}

test('lists tracked and untracked paths with Git ignore rules and exact unusual filenames', async () => {
  const { project, root, command, write } = fixture(true)
  write('.gitignore', '*.log\nignored/\n!kept.log\n')
  write('tracked.txt')
  write('deleted.txt')
  command('add', '.')
  rmSync(join(root, 'deleted.txt'))
  const unusual = ['space name.txt', 'quote"file.txt', 'tab\tfile.txt', 'line\nfile.txt', 'unicodé-文件.txt', '-option.txt', 'back\\slash.txt']
  for (const path of unusual) write(path)
  write('src/new.ts')
  write('hidden.log')
  write('kept.log')
  write('ignored/secret.txt')
  write('local-only.txt')
  write('.git/info/exclude', 'local-only.txt\n')
  write('nested/.gitignore', '*.tmp\n')
  write('nested/excluded.tmp')
  write('node_modules/force-tracked.js')
  command('add', '-f', 'node_modules/force-tracked.js')
  const result = await listProjectFiles(project)
  expect(result).toEqual({
    projectId: project.id, source: 'git', truncated: false, warnings: [], error: null,
    paths: ['.gitignore', 'tracked.txt', 'src/new.ts', 'kept.log', 'nested/.gitignore', ...unusual].sort()
  })
  expect(JSON.stringify(result)).not.toContain('Contents must never be returned')
  expect(JSON.stringify(result)).not.toContain(root)
})

test('uses the registered subdirectory and ignores inherited Git repository overrides', async () => {
  const { root, write } = fixture(true)
  const outside = fixture(true)
  outside.write('private.txt')
  write('sibling.txt')
  write('selected/own file.ts')
  vi.stubEnv('GIT_DIR', join(outside.root, '.git'))
  vi.stubEnv('GIT_WORK_TREE', outside.root)
  onTestCleanup(() => { vi.unstubAllEnvs() })
  const result = await listProjectFiles({ id: 'nested', path: join(root, 'selected') })
  expect(result.paths).toEqual(['own file.ts'])
  expect(result.source).toBe('git')
})

test('non-Git fallback excludes internals, dependency and build directories at every depth', async () => {
  const { project, write } = fixture()
  for (const dir of ['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '.yarn', 'dist', 'out', 'build', 'target', 'coverage']) {
    write(`nested/${dir}/hidden.txt`)
  }
  write('src/app.ts')
  write('.hidden')
  write('space dir/file.txt')
  const result = await listProjectFiles(project)
  expect(result.paths).toEqual(['.hidden', 'space dir/file.txt', 'src/app.ts'])
  expect(result).toMatchObject({ source: 'directory', truncated: false, warnings: [], error: null })
})

test('does not traverse symlinks to files, directories, ancestors or external projects', async () => {
  for (const git of [false, true]) {
    const { root, project, write, command } = fixture(git)
    const outside = fixture()
    outside.write('secret.txt')
    write('real/own.txt')
    symlinkSync(outside.root, join(root, 'outside'), 'dir')
    symlinkSync(join(outside.root, 'secret.txt'), join(root, 'secret.txt'))
    symlinkSync(join(root, 'real'), join(root, 'inside'), 'dir')
    symlinkSync(root, join(root, 'real/loop'), 'dir')
    symlinkSync(join(root, 'missing'), join(root, 'broken'))
    if (git) command('add', '.')
    expect((await listProjectFiles(project)).paths).toEqual(['real/own.txt'])
  }
})

test('rejects traversal and absolute paths without rewriting legal filenames', () => {
  for (const path of ['', '../private', 'a/../../private', '/etc/passwd', 'C:/private', 'a//b', './a', 'a/./b', 'a/../b', 'a\0b', 'a/.git/config', 'a/node_modules/b']) {
    expect(projectFileParts(path)).toBeNull()
  }
  expect(projectFileParts('space dir/line\nname.txt')).toEqual(['space dir', 'line\nname.txt'])
})

test('refreshes after additions, deletion and branch checkout without retaining snapshots', async () => {
  const { root, project, write, command } = fixture(true)
  write('main.txt')
  command('add', '.')
  command('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Initial')
  expect((await listProjectFiles(project)).paths).toEqual(['main.txt'])
  command('checkout', '-qb', 'other')
  command('rm', '-q', 'main.txt')
  write('other.txt')
  command('add', '.')
  command('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Other')
  write('untracked.txt')
  expect((await listProjectFiles(project)).paths).toEqual(['other.txt', 'untracked.txt'])
  rmSync(join(root, 'untracked.txt'))
  command('checkout', '-q', 'main')
  expect((await listProjectFiles(project)).paths).toEqual(['main.txt'])
})

test('lists linked worktrees, and rejects bare repository internals', async () => {
  const { project, command, write } = fixture(true)
  const linked = fixture()
  write('committed.txt')
  command('add', '.')
  command('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Initial')
  write('original-only.txt')
  command('worktree', 'add', '-q', '-b', 'linked', linked.root)
  expect((await listProjectFiles(linked.project)).paths).toEqual(['committed.txt'])
  expect((await listProjectFiles(project)).paths).toEqual(['committed.txt', 'original-only.txt'])
  const bare = fixture()
  bare.command('init', '--bare', '-q')
  expect((await listProjectFiles(bare.project)).error?.code).toBe('git-failed')
})

test('bounds Git output, results, directory entries and recursion depth', async () => {
  for (const git of [false, true]) {
    const { project, write } = fixture(git)
    for (let index = 0; index < 30; index += 1) write(`file-${index}.txt`)
    const entries = await listProjectFiles(project, { entries: 5 })
    expect(entries.paths.length).toBeLessThanOrEqual(5)
    expect(entries.truncated).toBe(true)
    const results = await listProjectFiles(project, { results: 3 })
    expect(results.paths).toHaveLength(3)
    expect(results.truncated).toBe(true)
    const bytes = await listProjectFiles(project, { bytes: 30 })
    expect(Buffer.byteLength(bytes.paths.map((path) => `${path}\0`).join(''))).toBeLessThanOrEqual(30)
    expect(bytes.truncated).toBe(true)
  }
  const { project, write } = fixture()
  write('a/b/c/too-deep.txt')
  write('a/visible.txt')
  const depth = await listProjectFiles(project, { depth: 2 })
  expect(depth.paths).toEqual(['a/visible.txt'])
  expect(depth.truncated).toBe(true)
})

test('large fixture returns bounded results while the event loop keeps servicing timers', async () => {
  const { project, write } = fixture(true)
  for (let index = 0; index < 2_000; index += 1) write(`file-${index.toString().padStart(5, '0')}.ts`)
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 1)
  onTestCleanup(() => clearInterval(timer))
  const started = performance.now()
  const result = await listProjectFiles(project, { entries: 1_000, results: 250 })
  expect(result.paths).toHaveLength(250)
  expect(result.truncated).toBe(true)
  expect(result.error).toBeNull()
  expect(ticks).toBeGreaterThan(0)
  expect(performance.now() - started).toBeLessThan(PROJECT_FILE_LIMITS.milliseconds + 1_000)
  console.info('Project file scan fixture:', {
    files: 2_000, entryLimit: 1_000, resultLimit: 250, returned: result.paths.length,
    truncated: result.truncated, timerTicks: ticks, elapsedMs: Math.round(performance.now() - started)
  })
})

test('reports missing projects, paths that are files and broken Git repositories', async () => {
  const { root, project, write } = fixture()
  write('file.txt')
  expect((await listProjectFiles({ ...project, path: join(root, 'file.txt') })).error?.code).toBe('unavailable')
  rmSync(root, { recursive: true })
  expect((await listProjectFiles(project)).error?.code).toBe('unavailable')
  const broken = fixture()
  broken.write('.git', 'gitdir: /nonexistent-anvil-project-files-repository\n')
  expect((await listProjectFiles(broken.project)).error?.code).toBe('git-failed')
})

test('reports unreadable subdirectories while retaining accessible paths', async () => {
  const { root, project, write } = fixture()
  write('accessible.txt')
  write('locked/secret.txt')
  chmodSync(join(root, 'locked'), 0)
  onTestCleanup(() => chmodSync(join(root, 'locked'), 0o700))
  const result = await listProjectFiles(project)
  expect(result.paths).toEqual(['accessible.txt'])
  expect(result.warnings).toEqual(['unreadable'])
  expect(result.error).toBeNull()
})

test('caps concurrent scans and releases slots after completion', async () => {
  const { project, write } = fixture()
  write('file.txt')
  const first = listProjectFiles(project)
  const second = listProjectFiles(project)
  const busy = await listProjectFiles(project)
  expect(busy.error?.code).toBe('busy')
  await Promise.all([first, second])
  expect((await listProjectFiles(project)).error).toBeNull()
})

test('deadline terminates a slow Git process and permits a subsequent refresh', async () => {
  const { root, project, write } = fixture()
  const executable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  write('bin/git', '#!/bin/sh\nexec sleep 10\n')
  chmodSync(join(root, 'bin/git'), 0o755)
  vi.stubEnv('PATH', `${join(root, 'bin')}:${process.env.PATH}`)
  onTestCleanup(() => { vi.unstubAllEnvs() })
  const started = performance.now()
  const result = await listProjectFiles(project, { milliseconds: 100 })
  expect(result.error?.code).toBe('timeout')
  expect(result.truncated).toBe(true)
  expect(performance.now() - started).toBeLessThan(2_000)
  rmSync(join(root, 'bin/git'))
  symlinkSync(executable, join(root, 'bin/git'))
  expect((await listProjectFiles(project)).error).toBeNull()
})

test('terminates stalled Git listing and reports listing failures without a directory fallback', async () => {
  const { root, project, write } = fixture()
  vi.stubEnv('PATH', `${join(root, 'bin')}:${process.env.PATH}`)
  onTestCleanup(() => { vi.unstubAllEnvs() })
  for (const listing of ['exec sleep 10', 'exit 1']) {
    write('bin/git', `#!/bin/sh\nif [ "$3" = "rev-parse" ]; then\n  echo true\nelse\n  ${listing}\nfi\n`)
    chmodSync(join(root, 'bin/git'), 0o755)
    const started = performance.now()
    const result = await listProjectFiles(project, { milliseconds: listing === 'exit 1' ? 5_000 : 750 })
    expect(result.error?.code).toBe(listing === 'exit 1' ? 'git-failed' : 'timeout')
    if (listing !== 'exit 1') expect(result.source).toBe('git')
    expect(result.paths).toEqual([])
    expect(performance.now() - started).toBeLessThan(2_000)
  }
})

test('discards a directory replaced by an external symlink before it is opened', async () => {
  const { root, project, write } = fixture()
  const outside = fixture()
  outside.write('secret.txt')
  write('swap/own.txt')
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).opendir
  onTestCleanup(() => { vi.mocked(fs.opendir).mockImplementation(original) })
  vi.mocked(fs.opendir).mockImplementation(async (path, ...args) => {
    if (path === join(root, 'swap')) {
      rmSync(join(root, 'swap'), { recursive: true })
      symlinkSync(outside.root, join(root, 'swap'), 'dir')
    }
    return original(path, ...args)
  })
  expect(await listProjectFiles(project)).toMatchObject({ paths: [], error: null, source: 'directory' })
})

test('uses a bounded directory fallback with a warning when Git is unavailable', async () => {
  const { root, project, write } = fixture()
  write('file.txt')
  vi.stubEnv('PATH', join(root, 'no-tools'))
  onTestCleanup(() => { vi.unstubAllEnvs() })
  expect(await listProjectFiles(project)).toEqual({
    projectId: project.id, paths: ['file.txt'], source: 'directory', truncated: false,
    warnings: ['git-unavailable'], error: null
  })
})

test('excluded Git dependency paths cannot exhaust the candidate budget', async () => {
  const { project, write, command } = fixture(true)
  for (let index = 0; index < 40; index += 1) {
    write(`node_modules/file-${index}.js`)
    write(`nested/Node_Modules/file-${index}.js`)
  }
  command('add', '.')
  write('src/app.ts')
  const result = await listProjectFiles(project, { entries: 5 })
  expect(result.paths).toEqual(['src/app.ts'])
  expect(result.truncated).toBe(false)
})
