import { expect, test, vi } from 'vitest'
import { EmbeddingProjectMemory, type EmbeddingOptions, type IndexedProjectMemory } from '../src/main/memory/embedding-project-memory'
import type { ProjectMemoryMatch } from '../src/main/memory/project-memory'
import { onTestCleanup } from './test-cleanup'

class Memory extends EmbeddingProjectMemory {
  constructor(options: EmbeddingOptions = {}) { super(options) }
  connect = async (): Promise<void> => {}
  close = async (): Promise<void> => {}
  forgetProject = async (): Promise<void> => {}
  upsert = vi.fn<(memory: IndexedProjectMemory) => Promise<void>>(async () => {})
  findSimilar = vi.fn<(_projectId: string, _embedding: number[], _limit: number) => Promise<ProjectMemoryMatch[]>>(async () => [])
}

function mockFetch() {
  const request = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', request)
  onTestCleanup(() => { vi.unstubAllGlobals() })
  return request
}

test('posts one bounded input to the configured embeddings endpoint and uses the vector for recall', async () => {
  const request = mockFetch()
  const vector = Array.from({ length: 1024 }, (_, index) => index / 1024)
  request.mockResolvedValue(Response.json({ data: [{ embedding: vector }] }))
  const memory = new Memory({ baseUrl: 'http://localhost:11434/v1/', modelId: 'custom-model' })
  await memory.recall('project', 'x'.repeat(3000), 100)
  expect(request).toHaveBeenCalledOnce()
  const [url, options] = request.mock.calls[0]
  expect(url).toBe('http://localhost:11434/v1/embeddings')
  expect(options?.method).toBe('POST')
  expect(JSON.parse(options!.body as string)).toEqual({ model: 'custom-model', input: 'x'.repeat(1800) })
  expect(options?.signal).toBeInstanceOf(AbortSignal)
  expect(memory.findSimilar).toHaveBeenCalledWith('project', vector, 20)
})

test.each([{}, { data: [] }, { data: [{ embedding: ['bad'] }] }, { data: [{ embedding: [null] }] }, { data: [{ embedding: [] }, { embedding: [] }] }])('rejects malformed embedding responses without retrying', async (body) => {
  const request = mockFetch().mockResolvedValue(Response.json(body))
  const memory = new Memory()
  await expect(memory.recall('project', 'query')).rejects.toThrow(/finite numeric vector/)
  expect(request).toHaveBeenCalledOnce()
  expect(memory.findSimilar).not.toHaveBeenCalled()
})

test('rejects wrong dimensions, HTTP failures and aborts without retries', async () => {
  const request = mockFetch()
  const memory = new Memory()
  request.mockResolvedValueOnce(Response.json({ data: [{ embedding: [1, 2] }] }))
  await expect(memory.recall('project', 'query')).rejects.toThrow('returned 2 dimensions')
  request.mockResolvedValueOnce(new Response('private server details', { status: 503 }))
  await expect(memory.recall('project', 'query')).rejects.toThrow('HTTP 503')
  request.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
  await expect(memory.recall('project', 'query')).rejects.toThrow('Timed out')
  expect(request).toHaveBeenCalledTimes(3)
  expect(memory.findSimilar).not.toHaveBeenCalled()
})
