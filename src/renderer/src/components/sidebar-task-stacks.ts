import type { Task } from '@shared/types'

export function sidebarTaskStacks(tasks: Task[]): { task: Task; stackStart: boolean; stackEnd: boolean }[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const groups = new Map<string, Task[]>()
  for (const task of tasks) {
    let root = task
    const visited = new Set([task.id])
    while (true) {
      const parentId = root.restackTarget?.parentTaskId ?? root.parentTaskId
      const parent = parentId ? taskById.get(parentId) : undefined
      if (!parent || visited.has(parent.id)) break
      visited.add(parent.id)
      root = parent
    }
    const group = groups.get(root.id) ?? []
    group.push(task)
    groups.set(root.id, group)
  }
  return [...groups.values()].flatMap((group) => {
    // The main list is newest first. Inside a stack, retain creation order so
    // later children join below the tasks already in the queue.
    const queued = [...group].sort((first, second) => first.startedAt - second.startedAt || first.id.localeCompare(second.id))
    const ordered: Task[] = []
    const remaining = new Set(group)
    const append = (task: Task): void => {
      if (!remaining.delete(task)) return
      ordered.push(task)
      for (const child of queued) {
        if ((child.restackTarget?.parentTaskId ?? child.parentTaskId) === task.id) append(child)
      }
    }
    for (const task of group) {
      const parentId = task.restackTarget?.parentTaskId ?? task.parentTaskId
      if (!group.some((entry) => entry.id === parentId)) append(task)
    }
    for (const task of remaining) append(task)
    const isStack = group.length > 1 || Boolean(group[0].restackTarget?.parentTaskId ?? group[0].parentTaskId)
    return ordered.map((task, index) => ({
      task,
      stackStart: isStack && index === 0,
      stackEnd: isStack && index === ordered.length - 1
    }))
  })
}
