import { expect, test, vi } from 'vitest'
import { createAnvilHttpServer } from '../src/server/http'
import { registerCaffeineMode } from '../src/client/main/caffeine-mode'
import { createServerCaffeineActivity } from '../src/client/main/server-activity'
import type { CaffeineState } from '../src/shared/caffeine'
import type { Project, Task, Workspace } from '../src/shared/types'
import { registerTestIpc } from './test-ipc'
import { onTestCleanup } from './test-cleanup'
import { testHome } from './issue-tracker-doubles'

test('desktop caffeine follows HTTP activity across workspace selection, disconnect and reconnect without a renderer', async () => {
  const runtime = registerTestIpc()
  const http = createAnvilHttpServer(runtime, { version: 'test' })
  const url = await http.listen(0)
  onTestCleanup(() => http.close())
  const rpc = async <T>(channel: string, input?: unknown): Promise<T> => {
    const response = await fetch(`${url}/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, input })
    })
    expect(response.ok).toBe(true)
    return response.json() as Promise<T>
  }
  const project = await rpc<Project>('projects:add', { path: testHome })
  await rpc('settings:set', { workspaceId: 'default', patch: { caffeineMode: true } })
  const task = await rpc<Task>('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Stay awake' })
  expect(await rpc('app:caffeine')).toEqual({ keepAwake: true })

  const blocker = { start: vi.fn(() => 0), stop: vi.fn(() => true) }
  const stop = registerCaffeineMode(createServerCaffeineActivity(url), blocker)
  onTestCleanup(stop)
  await vi.waitFor(() => expect(blocker.start).toHaveBeenCalledExactlyOnceWith('prevent-display-sleep'))
  const other = await rpc<Workspace>('workspaces:create', 'Other')
  await rpc('workspaces:select', other.id)
  await rpc('settings:set', { workspaceId: other.id, patch: { caffeineMode: false } })
  expect(await rpc('app:caffeine')).toEqual({ keepAwake: true })
  expect(blocker.stop).not.toHaveBeenCalled()

  await rpc('settings:set', { workspaceId: 'default', patch: { caffeineMode: false } })
  await vi.waitFor(() => expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0))
  await rpc('settings:set', { workspaceId: 'default', patch: { caffeineMode: true } })
  await vi.waitFor(() => expect(blocker.start).toHaveBeenCalledTimes(2))
  await http.close()
  await vi.waitFor(() => expect(blocker.stop).toHaveBeenCalledTimes(2))

  const reconnected = createAnvilHttpServer(runtime, { version: 'test' })
  onTestCleanup(() => reconnected.close())
  await reconnected.listen(Number(new URL(url).port))
  await vi.waitFor(() => expect(blocker.start).toHaveBeenCalledTimes(3), { timeout: 3_000 })
  await rpc('tasks:cancel', task.id)
  await vi.waitFor(() => expect(blocker.stop).toHaveBeenCalledTimes(3))

  const next = await rpc<Task>('tasks:start', { workspaceId: other.id, projectId: (await rpc<Project>('projects:add', { path: testHome })).id, agentId: 'codex', prompt: 'Shutdown' })
  await rpc('settings:set', { workspaceId: other.id, patch: { caffeineMode: true } })
  await vi.waitFor(() => expect(blocker.start).toHaveBeenCalledTimes(4))
  stop()
  stop()
  expect(blocker.stop).toHaveBeenCalledTimes(4)
  await rpc('tasks:cancel', next.id)
  expect(blocker.start).toHaveBeenCalledTimes(4)
})

test('a delayed initial snapshot cannot overwrite a newer SSE state', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller } })
  let finishSnapshot!: (response: Response) => void
  const snapshot = new Promise<Response>((resolve) => { finishSnapshot = resolve })
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/events')) return new Response(body)
    return snapshot
  })
  vi.stubGlobal('fetch', fetch)
  onTestCleanup(() => { vi.unstubAllGlobals() })
  const received: CaffeineState[] = []
  const stop = createServerCaffeineActivity('http://127.0.0.1:4780').subscribe((state) => received.push(state))
  onTestCleanup(() => { stop(); stream.close() })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  const event = new TextEncoder().encode('data: {"channel":"app:caffeine","payload":{"keepAwake":false}}\n\n')
  stream.enqueue(event.slice(0, 15))
  stream.enqueue(event.slice(15))
  await vi.waitFor(() => expect(received).toEqual([{ keepAwake: false }]))
  finishSnapshot(Response.json({ keepAwake: true }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(received).toEqual([{ keepAwake: false }])
  stop()
})
