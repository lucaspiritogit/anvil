import { test, expect, vi } from 'vitest'
import { createEventLatch } from '../src/shared/event-latch'

test('delivers a value to subscribers present at delivery time exactly once', () => {
  const latch = createEventLatch<number>()
  const handler = vi.fn()
  latch.subscribe(handler)
  latch.deliver(1)
  expect(handler).toHaveBeenCalledTimes(1)
  expect(handler).toHaveBeenCalledWith(1)
})

test('replays the latest buffered value to a late subscriber exactly once', () => {
  const latch = createEventLatch<string>()
  latch.deliver('first')
  latch.deliver('latest')
  const handler = vi.fn()
  latch.subscribe(handler)
  expect(handler).toHaveBeenCalledTimes(1)
  expect(handler).toHaveBeenCalledWith('latest')
  latch.deliver('next')
  expect(handler).toHaveBeenCalledTimes(2)
  expect(handler).toHaveBeenLastCalledWith('next')
})

test('stops delivering after unsubscribe and tolerates a double unsubscribe', () => {
  const latch = createEventLatch<number>()
  const handler = vi.fn()
  const unsubscribe = latch.subscribe(handler)
  unsubscribe()
  unsubscribe()
  latch.deliver(1)
  expect(handler).not.toHaveBeenCalled()
})
