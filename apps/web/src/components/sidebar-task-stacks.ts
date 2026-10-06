import type { Task, TaskStackOrigin } from '@anvil/protocol/types'

export interface SidebarStackTree {
  rootId: string
  depth: number
  origin?: TaskStackOrigin
  next?: TaskStackOrigin
  rails: (TaskStackOrigin | null)[]
  stem?: TaskStackOrigin
  size: number
  collapsed: boolean
  hiddenWorking: number
}

export interface SidebarStackRow {
  task: Task
  stackStart: boolean
  stackEnd: boolean
  tree: SidebarStackTree | null
}

const parentOf = (task: Task): string | undefined => task.restackTarget?.parentTaskId ?? task.parentTaskId
const originOf = (task: Task | undefined): TaskStackOrigin | undefined => task && (task.stackOrigin ?? 'manual')

export function sidebarTaskStacks(tasks: Task[], collapsedStacks: ReadonlySet<string> = new Set()): SidebarStackRow[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const groups = new Map<string, Task[]>()
  for (const task of tasks) {
    let root = task
    const visited = new Set([task.id])
    while (true) {
      const parentId = parentOf(root)
      const parent = parentId ? taskById.get(parentId) : undefined
      if (!parent || visited.has(parent.id)) break
      visited.add(parent.id)
      root = parent
    }
    const group = groups.get(root.id) ?? []
    group.push(task)
    groups.set(root.id, group)
  }
  return [...groups.entries()].flatMap(([rootId, group]) => {
    const members = new Set(group.map((task) => task.id))
    const children = new Map<string, Task[]>()
    for (const task of group) {
      const parentId = parentOf(task)
      if (task.id === rootId || !parentId || !members.has(parentId)) continue
      children.set(parentId, [...children.get(parentId) ?? [], task])
    }
    for (const siblings of children.values()) siblings.sort((first, second) => first.startedAt - second.startedAt || first.id.localeCompare(second.id))

    const rows: Omit<SidebarStackTree, 'rootId' | 'size' | 'collapsed' | 'hiddenWorking'>[] = []
    const ordered: Task[] = []
    const remaining = new Set(group)
    const visit = (task: Task, depth: number, rails: (TaskStackOrigin | null)[], edge?: { origin?: TaskStackOrigin; next?: TaskStackOrigin }): void => {
      if (!remaining.delete(task)) return
      const below = children.get(task.id) ?? []
      ordered.push(task)
      rows.push({ depth, rails, origin: edge?.origin, next: edge?.next, stem: originOf(below[0]) })
      below.forEach((child, index) => visit(child, depth + 1, depth === 0 ? [] : [...rails, edge?.next ?? null],
        { origin: originOf(child), next: originOf(below[index + 1]) }))
    }
    const root = group.find((task) => task.id === rootId)
    if (root) visit(root, 0, [])
    for (const task of [...remaining]) visit(task, 0, [])

    const isStack = group.length > 1 || Boolean(parentOf(group[0]))
    const collapsed = isStack && ordered.length > 1 && collapsedStacks.has(rootId)
    const visible = collapsed ? 1 : ordered.length
    const hiddenWorking = collapsed ? ordered.slice(1).filter((task) => task.status === 'running').length : 0
    return ordered.slice(0, visible).map((task, index) => ({
      task,
      stackStart: isStack && index === 0,
      stackEnd: isStack && index === visible - 1,
      tree: isStack ? {
        ...rows[index],
        ...(collapsed ? { stem: undefined } : {}),
        rootId,
        size: ordered.length,
        collapsed,
        hiddenWorking
      } : null
    }))
  })
}
