import { expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readdirSync } from 'node:fs'
import { GitDeliveryManager } from '../src/server/git'
import { GitDeliveryManager as DoubleGit, AgentProcessManager, app, handlers, testHome } from './issue-tracker-doubles'
import { onTestCleanup } from './test-cleanup'

let database: Database.Database
let agent: AgentProcessManager
let timer: ReturnType<typeof setInterval>
let intervalDisposed = false

test('starts in empty suite storage and defaults to orchestration Git doubles', () => {
  expect(readdirSync(testHome)).toEqual([])
  expect(GitDeliveryManager).toBe(DoubleGit)
  database = new Database(':memory:')
  expect(database.prepare('select 42 as answer').get()).toEqual({ answer: 42 })
  agent = new AgentProcessManager()
  agent.active.add('probe')
  handlers.set('probe', () => {})
  DoubleGit.failFinalize = true
  app.isPackaged = false
  process.env.ANVIL_ISOLATION_PROBE = 'dirty'
  timer = setInterval(() => {}, 1000)
  onTestCleanup(() => { clearInterval(timer); intervalDisposed = true })
  vi.useFakeTimers()
  setTimeout(() => { throw new Error('Fake timer leaked into another test') }, 1000)
})

test('closes databases and timers, resets doubles, and restores the suite environment', () => {
  expect(database.open).toBe(false)
  expect(agent.active.size).toBe(0)
  expect(handlers.size).toBe(0)
  expect(DoubleGit.failFinalize).toBe(false)
  expect(app.isPackaged).toBe(true)
  expect(process.env.ANVIL_ISOLATION_PROBE).toBeUndefined()
  expect(process.env.HOME).toBe(testHome)
  expect(intervalDisposed).toBe(true)
  expect(vi.isFakeTimers()).toBe(false)
})
