import { createRpcInvoker } from '@anvil/client-api'
import type { IpcRequests } from '@anvil/protocol/ipc-requests'

type QueueApi = {
  removeQueued(input: IpcRequests['tasks:queue:remove']): Promise<void>
  editQueued(input: IpcRequests['tasks:queue:edit']): Promise<void>
  steerQueued(input: IpcRequests['tasks:queue:steer']): Promise<void>
}

export function queueApi(): QueueApi {
  const tasks: Partial<QueueApi> = window.anvil.tasks
  const invoke = createRpcInvoker(window.location.origin)
  return {
    removeQueued: tasks.removeQueued ?? ((input) => invoke('tasks:queue:remove', input)),
    editQueued: tasks.editQueued ?? ((input) => invoke('tasks:queue:edit', input)),
    steerQueued: tasks.steerQueued ?? ((input) => invoke('tasks:queue:steer', input))
  }
}
