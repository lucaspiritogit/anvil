import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import { createNotificationDelivery, type NotificationAuthorization, type NotificationDeliveryOptions } from '../src/client/main/notification-delivery'
import { onTestCleanup } from './test-cleanup'

function setup(options: NotificationDeliveryOptions = {}) {
  const notifications: Notification[] = []
  class Notification extends EventEmitter {
    static isSupported = vi.fn(() => true)
    show = vi.fn()
    close = vi.fn()
    constructor() { super(); notifications.push(this) }
  }
  const delivery = createNotificationDelivery(Notification, options)
  onTestCleanup(() => delivery.dispose())
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestCleanup(() => warning.mockRestore())
  return { delivery, notifications, Notification, warning }
}

test('waits for a shared first-use authorization and delivers each triggering event once', async () => {
  let resolve!: (status: NotificationAuthorization) => void
  const authorize = vi.fn(() => new Promise<NotificationAuthorization>((done) => { resolve = done }))
  const { delivery, notifications, Notification } = setup({ authorize })
  delivery.send({ title: 'First' })
  delivery.send({ title: 'Second' })
  expect(authorize).toHaveBeenCalledOnce()
  expect(notifications).toHaveLength(0)
  expect(Notification.isSupported).not.toHaveBeenCalled()
  resolve('granted')
  await vi.waitFor(() => expect(notifications).toHaveLength(2))
  for (const notification of notifications) expect(notification.show).toHaveBeenCalledOnce()
  expect(Notification.isSupported).toHaveBeenCalledTimes(2)
})

test('drops denied events, reports recovery once and detects later Settings authorization', async () => {
  const authorize = vi.fn<() => Promise<NotificationAuthorization>>().mockResolvedValue('denied')
  const onUnavailable = vi.fn()
  const { delivery, notifications, Notification } = setup({ authorize, onUnavailable })
  delivery.send({ title: 'Denied' })
  await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce())
  delivery.send({ title: 'Still denied' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(onUnavailable).toHaveBeenCalledOnce()
  expect(notifications).toHaveLength(0)
  expect(Notification.isSupported).not.toHaveBeenCalled()
  authorize.mockResolvedValue('granted')
  delivery.send({ title: 'New event after enabling' })
  await vi.waitFor(() => expect(notifications).toHaveLength(1))
})

test('authorization errors and recovery errors stay isolated from execution', async () => {
  const { delivery, notifications, warning } = setup({
    authorize: () => Promise.reject(new Error('Unsigned bundle')),
    onUnavailable: () => Promise.reject(new Error('Settings unavailable'))
  })
  expect(() => delivery.send({ title: 'Task' })).not.toThrow()
  await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(2))
  expect(notifications).toHaveLength(0)
})

test('shutdown suppresses pending authorization delivery and recovery', async () => {
  let resolve!: (status: NotificationAuthorization) => void
  const onUnavailable = vi.fn()
  const { delivery, notifications } = setup({
    authorize: () => new Promise((done) => { resolve = done }), onUnavailable
  })
  delivery.send({ title: 'Pending' })
  delivery.dispose()
  resolve('granted')
  await new Promise<void>((done) => setImmediate(done))
  expect(notifications).toHaveLength(0)
  expect(onUnavailable).not.toHaveBeenCalled()
})

test('retains delivery listeners until failure or close and closes active notifications on shutdown', () => {
  const { delivery, notifications } = setup()
  delivery.send({ title: 'Failed' })
  delivery.send({ title: 'Closed' })
  delivery.send({ title: 'Active' })
  expect(notifications[0].listenerCount('failed')).toBe(1)
  notifications[0].emit('failed', {}, 'Native delivery failed')
  notifications[1].emit('close')
  expect(notifications[0].eventNames()).toEqual([])
  expect(notifications[1].eventNames()).toEqual([])
  delivery.dispose()
  delivery.dispose()
  expect(notifications[2].eventNames()).toEqual([])
  expect(notifications[2].close).toHaveBeenCalledOnce()
  expect(notifications[0].close).not.toHaveBeenCalled()
  delivery.send({ title: 'After disposal' })
  expect(notifications).toHaveLength(3)
})

test('bounds retained native notifications that are never dismissed', () => {
  const { delivery, notifications } = setup()
  for (let i = 0; i < 101; i++) delivery.send({ title: `Task ${i}` })
  expect(notifications[0].close).toHaveBeenCalledOnce()
  expect(notifications[0].eventNames()).toEqual([])
  expect(notifications[1].close).not.toHaveBeenCalled()
})

test('disabled delivery never initializes native notifications or requests authorization', () => {
  const authorize = vi.fn()
  const onUnavailable = vi.fn()
  const { delivery, notifications, Notification } = setup({ enabled: false, authorize, onUnavailable })
  delivery.send({ title: 'Finished' })
  expect(authorize).not.toHaveBeenCalled()
  expect(Notification.isSupported).not.toHaveBeenCalled()
  expect(notifications).toHaveLength(0)
  expect(onUnavailable).not.toHaveBeenCalled()
})
