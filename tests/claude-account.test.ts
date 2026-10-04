import { expect, test, vi } from 'vitest'
import { parseClaudeAccountStatus, readNativeClaudeAccount } from '../apps/server/src/agents/claude-account'
import { parseClaudeRateLimits } from '../apps/server/src/agents/claude-usage'
import { testWorkspace } from './workspace-fixture'
import { claudeWorkspaceEnvironment } from '../apps/server/src/agents/claude-workspace'

const native = vi.hoisted(() => ({ execFile: vi.fn(), resolveCommand: vi.fn() }))
vi.mock('node:child_process', async () => ({ ...await vi.importActual<typeof import('node:child_process')>('node:child_process'), execFile: native.execFile }))
vi.mock('../apps/server/src/agents/resolve', () => ({ resolveCommand: native.resolveCommand }))

test('Claude status returns subscription identity without arbitrary native account fields', () => {
  expect(parseClaudeAccountStatus({
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.test', subscriptionType: 'max',
    accessToken: 'secret', orgId: 'private', projectsDirectory: '/private/path'
  })).toEqual({ loggedIn: true, subscription: true, email: 'person@example.test', subscriptionType: 'max' })
  expect(parseClaudeAccountStatus({ loggedIn: false })).toEqual({ loggedIn: false, subscription: false, email: null, subscriptionType: null })
  expect(parseClaudeAccountStatus({ loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty', email: 'api@example.test' })).toEqual({
    loggedIn: true, subscription: false, email: null, subscriptionType: null
  })
  expect(parseClaudeAccountStatus({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }).subscription).toBe(false)
  expect(() => parseClaudeAccountStatus({ loggedIn: 'yes', accessToken: 'secret' })).toThrow('Invalid Claude account status')
})

test('Claude native status runs in its owner profile and handles signed-out exit status', async () => {
  const workspace = testWorkspace('work')
  native.resolveCommand.mockReturnValue({ command: '/bin/claude', prefixArgs: [], viaShell: false })
  native.execFile.mockImplementation((_command, _args, _options, callback) => {
    callback(Object.assign(new Error('sensitive CLI diagnostic'), { code: 1 }), '{"loggedIn":false}')
  })
  await expect(readNativeClaudeAccount(workspace)).resolves.toMatchObject({ loggedIn: false, subscription: false })
  expect(native.execFile).toHaveBeenCalledWith('/bin/claude', ['auth', 'status', '--json'], expect.objectContaining({
    cwd: workspace.home, env: expect.objectContaining(claudeWorkspaceEnvironment(workspace))
  }), expect.any(Function))
  native.execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error('token-secret'), 'token-secret'))
  await expect(readNativeClaudeAccount(workspace)).rejects.toThrow('Claude account status unavailable')
  native.resolveCommand.mockReturnValue(null)
  await expect(readNativeClaudeAccount(workspace)).rejects.toThrow('Claude Code unavailable')
})

test('Claude usage reports five-hour, weekly-all and explicitly identified weekly Fable windows', () => {
  const resetsAt = '2026-10-10T18:00:00Z'
  expect(parseClaudeRateLimits({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 20, resets_at: null },
    seven_day: { utilization: 35, resets_at: resetsAt },
    model_scoped: [
      { display_name: 'Sonnet', utilization: 80, resets_at: resetsAt },
      { display_name: 'Fable', utilization: 45, resets_at: resetsAt }
    ]
  } })).toEqual({
    fiveHour: { usedPercent: 20, resetsAt: null },
    weeklyAll: { usedPercent: 35, resetsAt: Date.parse(resetsAt) / 1000 },
    weeklyFable: { usedPercent: 45, resetsAt: Date.parse(resetsAt) / 1000 }
  })
})

test('Claude usage accepts native limits arrays and clamps reported percentages', () => {
  expect(parseClaudeRateLimits({ rate_limits_available: true, rate_limits: { limits: [
    { kind: 'session', percent: -2, resets_at: 1000 },
    { kind: 'weekly_all', percent: 120, resets_at: 2000 },
    { kind: 'weekly_scoped', percent: 50, resets_at: 2000, scope: { model: { display_name: 'Fable' } } }
  ] } })).toEqual({
    fiveHour: { usedPercent: 0, resetsAt: 1000 },
    weeklyAll: { usedPercent: 100, resetsAt: 2000 },
    weeklyFable: { usedPercent: 50, resetsAt: 2000 }
  })
})

test('Claude usage leaves absent and unavailable windows unknown without substituting another model', () => {
  const empty = { fiveHour: null, weeklyAll: null, weeklyFable: null }
  expect(parseClaudeRateLimits({ rate_limits_available: false })).toEqual(empty)
  expect(parseClaudeRateLimits({ rate_limits: null })).toEqual(empty)
  expect(parseClaudeRateLimits({ rate_limits_available: true, rate_limits: { model_scoped: [{ display_name: 'Sonnet', utilization: 80 }] } })).toEqual(empty)
  expect(parseClaudeRateLimits({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 10 } } })).toEqual({
    ...empty, weeklyAll: { usedPercent: 10, resetsAt: null }
  })
  expect(parseClaudeRateLimits({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: null, resets_at: null },
    model_scoped: [{ display_name: 'Fable', utilization: null, resets_at: null }]
  } })).toEqual({ ...empty, fiveHour: { usedPercent: 10, resetsAt: null } })
  for (const utilization of [NaN, Infinity, '30', undefined]) {
    expect(() => parseClaudeRateLimits({ rate_limits: { five_hour: { utilization } } })).toThrow('Invalid Claude usage percentage')
  }
  expect(() => parseClaudeRateLimits({ rate_limits: { five_hour: { utilization: 10, resets_at: 'invalid' } } })).toThrow('Invalid Claude usage reset time')
  expect(() => parseClaudeRateLimits({})).toThrow('Invalid Claude usage response')
})
