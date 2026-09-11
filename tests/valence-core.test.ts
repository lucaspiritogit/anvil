import { expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { Store } from '../src/main/store'
import { IssueTracker } from '../src/main/valence/tracker'
import type { CreateIssue, CreateParentIssue, IssueSelection, UpdateIssue, UpdateParentIssue } from '../src/shared/valence'
import { onTestCleanup } from './test-cleanup'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-valence-core-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const registryPath = join(directory, 'anvil.db')
  const store = new Store(registryPath, { migrationsFolder: resolve('src/main/db/migrations') })
  onTestCleanup(() => store.close())
  const path = store.getWorkspaceDatabasePath('default')
  const db = new Database(path)
  onTestCleanup(() => { db.close() })
  for (const project of ['a', 'b']) {
    db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, 1)').run(project, project, `/${project}`)
    for (const suffix of ['1', '2']) db.prepare(`INSERT INTO tasks
      (id, project_id, agent_id, agent_label, prompt, title, cwd, status, started_at)
      VALUES (?, ?, 'codex', 'Codex', 'Prompt', 'Title', '/test', 'succeeded', 1)`).run(project + suffix, project)
  }
  const a = store.issueTracker('a')
  const b = store.issueTracker('b')
  const pa = a.createParent({ anvilTaskId: 'a1', title: 'Parent A' })
  const pb = b.createParent({ anvilTaskId: 'b1', title: 'Parent B' })
  const input = (patch: Partial<CreateIssue> = {}): CreateIssue => ({
    parentId: pa.id, title: 'Issue', description: 'Description', checklist: ['Check'], validation: 'Run tests', ...patch
  })
  return { directory, registryPath, path, store, db, a, b, pa, pb, input }
}

test('verified no-change completion preserves evidence without developer approval and unlocks dependencies', () => {
  const { a, b, pb, store, input } = fixture()
  const issue = a.create(input())
  const dependent = a.create(input({ dependencies: [issue.id] }))
  const range = { baseCommit: 'base', headCommit: 'head' }
  expect(() => a.completeNoChanges(issue.id, range)).toThrow(/submitted/)
  a.start(issue.id)
  a.recordCommits(issue.id, range)
  expect(() => a.completeNoChanges(issue.id, range)).toThrow(/submitted/)
  expect(() => a.submitForReview(issue.id, { checklist: new Array(1), evidence: 'Checked' })).toThrow(/checklist/)
  a.block(issue.id)
  expect(() => a.completeNoChanges(issue.id, range)).toThrow(/submitted/)
  a.requeue(issue.id)
  a.start(issue.id)
  a.submitForReview(issue.id, { checklist: [true], evidence: 'Verified no remaining diff; checks passed' })
  expect(() => a.completeNoChanges(issue.id, { ...range, headCommit: 'stale' })).toThrow(/range/)
  const foreign = b.create(input({ parentId: pb.id }))
  expect(() => a.completeNoChanges(foreign.id, range)).toThrow(/not found/)
  const completed = a.completeNoChanges(issue.id, range)
  expect(completed).toMatchObject({ status: 'complete', completedAt: expect.any(Number), evidence: 'Verified no remaining diff; checks passed', ...range })
  expect(completed.reviewedAt).toBeUndefined()
  expect(a.ready().map((entry) => entry.id)).toEqual([dependent.id])
  expect(() => a.completeNoChanges(issue.id, range)).toThrow(/submitted/)
  const reopened = store.issueTracker('a')
  onTestCleanup(() => reopened.close())
  expect(reopened.get(issue.id)).toEqual(completed)
  expect(reopened.claim()?.id).toBe(dependent.id)
  expect(reopened.claim()).toBeUndefined()
})

test('no-change completion rejects a submitted issue without a saved range or evidence', () => {
  const { a, db, input } = fixture()
  const issue = a.create(input())
  a.start(issue.id)
  a.submitForReview(issue.id, { checklist: [true], evidence: 'Checked' })
  const range = { baseCommit: 'base', headCommit: 'head' }
  expect(() => a.completeNoChanges(issue.id, range)).toThrow(/range/)
  a.recordCommits(issue.id, range)
  db.prepare('UPDATE issues SET evidence = NULL WHERE id = ?').run(issue.id)
  expect(() => a.completeNoChanges(issue.id, range)).toThrow(/evidence/)
  expect(a.get(issue.id).status).toBe('review')
})

test('validates malformed issue and parent input without writes', () => {
  const { a, input } = fixture()
  for (const bad of [null, [], {}, { ...input(), title: ' ' }, { ...input(), checklist: [] },
    { ...input(), checklist: new Array(1) }, { ...input(), labels: ['x', ' x'] },
    { ...input(), dependencies: [1] }, { ...input(), priority: 'invalid' }, { ...input(), extra: true }]) {
    expect(() => a.create(bad as CreateIssue)).toThrow()
  }
  for (const bad of [null, [], { title: 'No task' }, { anvilTaskId: 'a2', title: 'X', description: 1 }]) {
    expect(() => a.createParent(bad as unknown as CreateParentIssue)).toThrow()
  }
  expect(a.list()).toEqual([])
  expect(a.listParents()).toHaveLength(1)
})

test('batch keys support forward dependencies; missing dependencies and cycles roll back', () => {
  const { a, db, input } = fixture()
  for (const batch of [
    [{ ...input(), key: 'x', dependencies: ['missing'] }],
    [{ ...input(), key: 'x', dependencies: ['y'] }, { ...input(), key: 'y', dependencies: ['x'] }],
    [{ ...input(), key: 'x', dependencies: ['x'] }],
    [{ ...input(), key: 'x' }, { ...input(), key: 'x' }]
  ]) expect(() => a.createMany(batch)).toThrow()
  expect(a.list()).toEqual([])
  // Fail after the first insert to prove SQLite rollback, not just prevalidation.
  db.exec(`CREATE TRIGGER reject_issue BEFORE INSERT ON issues WHEN NEW.title = 'Reject'
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
  expect(() => a.createMany([{ ...input(), key: 'x' }, { ...input({ title: 'Reject' }), key: 'y' }])).toThrow('injected failure')
  expect(a.list()).toEqual([])
  const [first, second] = a.createMany([
    { ...input(), key: 'first', dependencies: ['second'] }, { ...input(), key: 'second' }
  ])
  expect(first.dependencies).toEqual([second.id])
  expect(() => a.update(second.id, { dependencies: [first.id] })).toThrow(/cycles/)
  expect(() => a.update(second.id, { dependencies: [second.id] })).toThrow(/itself/)
  expect(() => a.update(second.id, { dependencies: ['missing'] })).toThrow(/Unknown/)
  expect(a.get(second.id).dependencies).toEqual([])
  expect(() => a.start(first.id)).toThrow(/incomplete/)
})

test('dependency write failures roll back batch rows and field replacements', () => {
  const { a, db, input } = fixture()
  const dependency = a.create(input())
  const issue = a.create(input({ labels: ['original'] }))
  db.exec(`CREATE TRIGGER reject_dependency BEFORE INSERT ON issue_dependencies
    BEGIN SELECT RAISE(ABORT, 'dependency failure'); END`)
  expect(() => a.update(issue.id, { title: 'Changed', labels: [], dependencies: [dependency.id] })).toThrow('dependency failure')
  expect(a.get(issue.id)).toEqual(issue)
  expect(() => a.createMany([
    { ...input(), key: 'first' }, { ...input(), key: 'second', dependencies: ['first'] }
  ])).toThrow('dependency failure')
  expect(a.list()).toEqual([dependency, issue])
  expect(db.pragma('foreign_key_check')).toEqual([])
})

test('priority then creation ordering, completion evidence, transitions and array replacement', () => {
  const { a, input } = fixture()
  const [low, high1, high2, urgent, medium] = a.createMany(
    (['low', 'high', 'high', 'urgent', 'medium'] as const).map((priority, i) => ({ ...input({ priority }), key: `${i}` }))
  )
  expect(a.ready().map(({ id }) => id)).toEqual([urgent.id, high1.id, high2.id, medium.id, low.id])
  expect(a.claim({ ids: [] })).toBeUndefined()
  expect(a.claim({ ids: [], parentId: low.parentId })).toBeUndefined()
  expect(a.claim()?.id).toBe(urgent.id)
  expect(() => a.update(urgent.id, { title: 'Changed' })).toThrow(/queued or blocked/)
  expect(() => a.submitForReview(urgent.id, { checklist: [], evidence: 'Test' })).toThrow(/checklist/)
  expect(() => a.submitForReview(urgent.id, { checklist: [false], evidence: 'Test' })).toThrow(/checklist/)
  expect(() => a.submitForReview(urgent.id, { checklist: [true], evidence: ' ' })).toThrow(/evidence/)
  expect(a.get(urgent.id).status).toBe('working')
  expect(a.submitForReview(urgent.id, { checklist: [true], evidence: ' Tests passed ' })).toMatchObject({ status: 'review', evidence: 'Tests passed' })
  expect(a.approve(urgent.id)).toMatchObject({ status: 'complete', evidence: 'Tests passed', completedAt: expect.any(Number), reviewedAt: expect.any(Number) })
  for (const action of [() => a.start(urgent.id), () => a.block(urgent.id), () => a.requeue(urgent.id), () => a.approve(urgent.id), () => a.reject(urgent.id)]) expect(action).toThrow()
  a.block(low.id)
  a.update(low.id, { labels: ['label'], dependencies: [urgent.id], checklist: ['New check'] })
  expect(a.update(low.id, { labels: [], dependencies: [] })).toMatchObject({ labels: [], dependencies: [], checklist: ['New check'] })
  a.requeue(low.id)
  a.start(low.id)
  a.block(low.id)
  a.requeue(low.id)
  a.start(low.id)
  expect(a.requeue(low.id).status).toBe('queued')
  expect(() => a.requeue(low.id)).toThrow()
  expect(() => a.update(low.id, { status: 'complete' } as UpdateIssue)).toThrow(/Unknown/)
})

test('records the first issue start in Unix milliseconds and preserves it through retries, review and restart', () => {
  const { a, input, store, registryPath } = fixture()
  const firstStartedAt = 1_789_000_000_123
  const clock = vi.spyOn(Date, 'now').mockReturnValue(firstStartedAt)
  const issue = a.create(input())
  const dependent = a.create(input({ dependencies: [issue.id] }))
  expect(issue.startedAt).toBeUndefined()
  expect(issue.completedAt).toBeUndefined()
  expect(() => a.start(dependent.id)).toThrow(/incomplete/)
  expect(a.get(dependent.id).startedAt).toBeUndefined()
  expect(a.claim({ ids: [issue.id] })).toMatchObject({ status: 'working', startedAt: firstStartedAt })

  clock.mockReturnValue(firstStartedAt + 1_000)
  a.block(issue.id)
  a.requeue(issue.id)
  expect(a.start(issue.id).startedAt).toBe(firstStartedAt)
  a.submitForReview(issue.id, { checklist: [true], evidence: 'First attempt' })
  expect(a.get(issue.id)).toMatchObject({ status: 'review', startedAt: firstStartedAt })
  expect(a.get(issue.id).completedAt).toBeUndefined()
  expect(a.reject(issue.id).startedAt).toBe(firstStartedAt)
  a.submitForReview(issue.id, { checklist: [true], evidence: 'Rework passed' })
  const completedAt = firstStartedAt + 10_000
  clock.mockReturnValue(completedAt)
  expect(a.approve(issue.id)).toMatchObject({ startedAt: firstStartedAt, completedAt, reviewedAt: completedAt })

  clock.mockReturnValue(completedAt + 1_000)
  expect(a.start(dependent.id).startedAt).toBe(completedAt + 1_000)
  a.close()
  store.close()
  const reopened = new Store(registryPath, { migrationsFolder: resolve('src/main/db/migrations') })
  onTestCleanup(() => reopened.close())
  expect(reopened.issueTracker('a').get(issue.id)).toMatchObject({ startedAt: firstStartedAt, completedAt })
  expect(reopened.issueTracker('a').list().find((entry) => entry.id === dependent.id)?.startedAt).toBe(completedAt + 1_000)
})

test('review status gates completion behind developer approval', () => {
  const { a, input } = fixture()
  const [first, second] = a.createMany([
    { ...input(), key: 'first' },
    { ...input(), key: 'second', dependencies: ['first'] }
  ])
  expect(a.ready().map(({ id }) => id)).toEqual([first.id])
  expect(() => a.submitForReview(first.id, { checklist: [true], evidence: 'Early' })).toThrow(/working/)
  expect(() => a.approve(first.id)).toThrow(/review/)
  expect(() => a.reject(first.id)).toThrow(/review/)
  a.start(first.id)
  expect(() => a.submitForReview(first.id, { checklist: [], evidence: 'Test' })).toThrow(/checklist/)
  expect(() => a.submitForReview(first.id, { checklist: [false], evidence: 'Test' })).toThrow(/checklist/)
  expect(() => a.submitForReview(first.id, { checklist: [true], evidence: ' ' })).toThrow(/evidence/)
  expect(a.submitForReview(first.id, { checklist: [true], evidence: ' Tests passed ' }))
    .toMatchObject({ status: 'review', evidence: 'Tests passed' })
  expect(a.ready()).toEqual([])
  expect(() => a.update(first.id, { title: 'Changed' })).toThrow(/queued or blocked/)
  expect(() => a.start(second.id)).toThrow(/incomplete/)
  expect(() => a.submitForReview(first.id, { checklist: [true], evidence: 'Again' })).toThrow(/working/)
  a.block(first.id)
  expect(a.get(first.id).status).toBe('blocked')
  expect(a.requeue(first.id).status).toBe('queued')
  a.start(first.id)
  a.submitForReview(first.id, { checklist: [true], evidence: 'Tests passed' })
  expect(a.approve(first.id)).toMatchObject({
    status: 'complete', evidence: 'Tests passed', completedAt: expect.any(Number), reviewedAt: expect.any(Number)
  })
  expect(a.ready().map(({ id }) => id)).toEqual([second.id])
  expect(() => a.approve(first.id)).toThrow(/review/)
  expect(() => a.reject(first.id)).toThrow(/review/)
})

test('reject returns review issues to working and clears evidence', () => {
  const { a, input } = fixture()
  const issue = a.create(input())
  a.start(issue.id)
  a.submitForReview(issue.id, { checklist: [true], evidence: 'First attempt' })
  expect(a.reject(issue.id)).toMatchObject({ status: 'working' })
  const rejected = a.get(issue.id)
  expect(rejected.evidence).toBeUndefined()
  expect(rejected.completedAt).toBeUndefined()
  expect(rejected.reviewedAt).toBeUndefined()
  expect(a.ready()).toEqual([])
  a.submitForReview(issue.id, { checklist: [true], evidence: 'Second attempt' })
  expect(a.approve(issue.id).evidence).toBe('Second attempt')
})

test('records per-issue commit ranges and re-captures the head after rework', () => {
  const { a, input } = fixture()
  const issue = a.create(input())
  expect(() => a.recordCommits(issue.id, {})).toThrow(/commit range/)
  expect(() => a.recordCommits(issue.id, { baseCommit: '   ' })).toThrow(/baseCommit/)
  expect(() => a.recordCommits('missing', { headCommit: 'd'.repeat(40) })).toThrow(/not found/)
  const base = 'a'.repeat(40)
  expect(a.recordCommits(issue.id, { baseCommit: base })).toMatchObject({ status: 'queued', baseCommit: base })
  a.start(issue.id)
  a.submitForReview(issue.id, { checklist: [true], evidence: 'First attempt' })
  const firstHead = 'b'.repeat(40)
  expect(a.recordCommits(issue.id, { headCommit: firstHead })).toMatchObject({ status: 'review', headCommit: firstHead })
  a.reject(issue.id)
  // Rejection keeps the range so rework extends the same diff.
  expect(a.get(issue.id)).toMatchObject({ status: 'working', baseCommit: base, headCommit: firstHead })
  a.submitForReview(issue.id, { checklist: [true], evidence: 'Rework' })
  const reworkHead = 'c'.repeat(40)
  expect(a.recordCommits(issue.id, { headCommit: reworkHead }).headCommit).toBe(reworkHead)
  expect(a.approve(issue.id)).toMatchObject({ status: 'complete', baseCommit: base, headCommit: reworkHead })
})

test('rejects foreign project IDs across CRUD, dependencies and selection', () => {
  const { a, b, pa, pb, input } = fixture()
  const foreign = b.create(input({ parentId: pb.id }))
  const own = a.create(input())
  const operations = [
    () => a.get(foreign.id), () => a.update(foreign.id, { title: 'Changed' }),
    () => a.start(foreign.id), () => a.block(foreign.id), () => a.requeue(foreign.id),
    () => a.submitForReview(foreign.id, { checklist: [true], evidence: 'Tests' }),
    () => a.getParent(pb.id), () => a.updateParent(pb.id, { title: 'Changed' }),
    () => a.list(pb.id), () => a.ready(pb.id), () => a.claim({ parentId: pb.id }),
    () => a.claim({ ids: [own.id, foreign.id] }),
    () => a.create(input({ parentId: pb.id })),
    () => a.create(input({ dependencies: [foreign.id] })),
    () => a.update(own.id, { parentId: pb.id }), () => a.update(own.id, { dependencies: [foreign.id] }),
    () => a.createParent({ anvilTaskId: 'b2', title: 'Foreign' }),
    () => a.updateParent(pa.id, { anvilTaskId: 'b2' } as UpdateParentIssue)
  ]
  for (const operation of operations) expect(operation).toThrow()
  expect(a.list()).toEqual([own])
  expect(a.ready()).toEqual([own])
  expect(a.listParents()).toEqual([pa])
  expect(b.get(foreign.id)).toEqual(foreign)
  expect(a.updateParent(pa.id, { description: ' Updated ' }).description).toBe('Updated')
  for (const selection of [null, {}, [], { ids: null }, { parentId: '' }, { ids: ['missing'] }, { ids: [], extra: true }]) {
    expect(() => a.claim(selection as IssueSelection)).toThrow()
  }
})

test('supports dependencies across parents in the same project and preserves persisted order', () => {
  const { a, input, store } = fixture()
  const secondParent = a.createParent({ anvilTaskId: 'a2', title: 'Second' })
  const dependency = a.create(input())
  const next = a.create(input({ parentId: secondParent.id, dependencies: [dependency.id] }))
  expect(a.ready(secondParent.id)).toEqual([])
  a.start(dependency.id)
  a.submitForReview(dependency.id, { checklist: [true], evidence: 'Passed' })
  a.approve(dependency.id)
  a.close()
  const reopened = store.issueTracker('a')
  expect(reopened.list().map(({ id }) => id)).toEqual([dependency.id, next.id])
  expect(reopened.claim({ parentId: secondParent.id })?.id).toBe(next.id)
})

test('borrowed tracker disposal leaves Store open; owned disposal closes only its connection', () => {
  const { a, store, path } = fixture()
  a.close()
  a.close()
  expect(() => a.list()).toThrow(/closed/)
  expect(store.issueTracker('a').listParents()).toHaveLength(1)
  const connection = new Database(path)
  const owned = new IssueTracker(connection, 'a', 'owned')
  owned.close()
  owned.close()
  expect(connection.open).toBe(false)
  expect(store.issueTracker('a').list()).toEqual([])
})

test('independent SQLite connections contend and claim each issue exactly once', async () => {
  const { a, input, path, directory, db } = fixture()
  const issues = a.createMany(Array.from({ length: 30 }, (_, index) => ({ ...input(), key: `${index}` })))
  const bundle = join(directory, 'tracker.cjs')
  await build({
    entryPoints: [resolve('src/main/valence/tracker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'host-sqlite', setup(build) {
      build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: resolve('node_modules/.anvil-vitest-native/better-sqlite3/lib/index.js'), external: true }))
    } }]
  })
  const barrier = new SharedArrayBuffer(4)
  const code = `
    const { parentPort, workerData } = require('node:worker_threads')
    const Database = require(workerData.sqlite)
    const { IssueTracker } = require(workerData.bundle)
    const db = new Database(workerData.path)
    const tracker = new IssueTracker(db, 'a', 'owned')
    parentPort.postMessage('ready')
    Atomics.wait(new Int32Array(workerData.barrier), 0, 0)
    const ids = []
    let issue
    while ((issue = tracker.claim())) ids.push(issue.id)
    tracker.close()
    parentPort.postMessage(ids)
  `
  const workers = Array.from({ length: 4 }, () => new Worker(code, { eval: true, workerData: {
    sqlite: resolve('node_modules/.anvil-vitest-native/better-sqlite3'), bundle, path, barrier
  } }))
  onTestCleanup(async () => { await Promise.all(workers.map((worker) => worker.terminate())) })
  const results: Promise<string[]>[] = []
  const ready = workers.map((worker) => new Promise<void>((resolveReady, rejectReady) => {
    results.push(new Promise<string[]>((resolveResult, rejectResult) => {
      worker.on('message', (message) => message === 'ready' ? resolveReady() : resolveResult(message))
      worker.on('error', (error) => { rejectReady(error); rejectResult(error) })
    }))
  }))
  const release = async () => {
    await Promise.all(ready)
    db.exec('BEGIN IMMEDIATE')
    try {
      Atomics.store(new Int32Array(barrier), 0, 1)
      Atomics.notify(new Int32Array(barrier), 0)
      // Hold the write lock while all workers attempt BEGIN IMMEDIATE.
      await new Promise((resolve) => setTimeout(resolve, 150))
    } finally { db.exec('COMMIT') }
  }
  const [claims] = await Promise.all([Promise.all(results), release()])
  const claimed = claims.flat()
  expect(claimed).toHaveLength(issues.length)
  expect(new Set(claimed).size).toBe(issues.length)
  expect([...claimed].sort()).toEqual(issues.map(({ id }) => id).sort())
  expect(a.list().every(({ status }) => status === 'working')).toBe(true)
})
