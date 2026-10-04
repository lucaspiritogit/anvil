import type { Project, Task, TaskIssueSnapshot } from '@anvil/protocol/types'
import { taskAttentionRank } from '@anvil/protocol/task-review'
import { sidebarTaskStacks } from './sidebar-task-stacks'

export const UNASSIGNED_TASK_GROUP = 'unassigned'

export type SidebarTaskEntry =
  | { kind: 'project'; key: string; project: Project; expanded: boolean; taskCount: number }
  | { kind: 'task'; key: string; task: Task; project?: Project; compact: boolean; indented: boolean; stackStart: boolean; stackEnd: boolean }
  | { kind: 'settled'; key: string; groupId: string; project?: Project; expanded: boolean; taskCount: number; indented: boolean }
  | { kind: 'empty'; key: string; message: string; indented: boolean }

export function sidebarTaskProjects({ workspaceId, projects, tasks, query, snapshots, taskSeenAt, collapsedProjects, expandedSettledGroups }: {
  workspaceId: string | null
  projects: Project[]
  tasks: Task[]
  query: string
  snapshots: ReadonlyMap<string, TaskIssueSnapshot | null>
  taskSeenAt: Record<string, number>
  collapsedProjects: ReadonlySet<string>
  expandedSettledGroups: ReadonlySet<string>
}): SidebarTaskEntry[] {
  const projectById = new Map(projects.map((project) => [project.id, project]))
  const search = query.trim().toLowerCase()
  const matchingTasks = tasks.filter((task) => {
    if (task.workspaceId !== workspaceId) return false
    const project = task.projectId ? projectById.get(task.projectId) : undefined
    return !search || [task.title, task.branchName, project?.name,
      ...(snapshots.get(task.id)?.children.map((issue) => issue.title) ?? [])]
      .some((text) => text?.toLowerCase().includes(search))
  })
  const tasksByProject = new Map<string, Task[]>()
  const unassignedTasks: Task[] = []
  for (const task of matchingTasks) {
    if (task.projectId && projectById.has(task.projectId)) {
      const projectTasks = tasksByProject.get(task.projectId) ?? []
      projectTasks.push(task)
      tasksByProject.set(task.projectId, projectTasks)
    } else {
      unassignedTasks.push(task)
    }
  }

  const entries: SidebarTaskEntry[] = []
  const appendTasks = (groupTasks: Task[], project?: Project): void => {
    const groupId = project ? `project:${project.id}` : UNASSIGNED_TASK_GROUP
    const indented = Boolean(project)
    const activeTasks = groupTasks.filter((task) => task.settledAt === undefined)
      .sort((first, second) => taskAttentionRank(first, taskSeenAt[first.id]) - taskAttentionRank(second, taskSeenAt[second.id]))
    const settledTasks = groupTasks.filter((task) => task.settledAt !== undefined)
      .sort((first, second) => second.settledAt! - first.settledAt!)
    for (const stack of sidebarTaskStacks(activeTasks)) {
      entries.push({ kind: 'task', key: stack.task.id, ...stack, project, compact: false, indented })
    }
    if (settledTasks.length) {
      const expanded = Boolean(search) || expandedSettledGroups.has(groupId)
      entries.push({ kind: 'settled', key: `settled:${groupId}`, groupId, project, expanded, taskCount: settledTasks.length, indented })
      if (expanded) {
        for (const stack of sidebarTaskStacks(settledTasks)) {
          entries.push({ kind: 'task', key: stack.task.id, ...stack, project, compact: true, indented })
        }
      }
    }
    if (project && !groupTasks.length && !search) {
      entries.push({ kind: 'empty', key: `empty:${groupId}`, message: 'No tasks yet.', indented })
    }
  }

  for (const project of projects) {
    const groupTasks = tasksByProject.get(project.id) ?? []
    const expanded = Boolean(search) || !collapsedProjects.has(project.id)
    entries.push({ kind: 'project', key: `project:${project.id}`, project, expanded, taskCount: groupTasks.length })
    if (expanded) appendTasks(groupTasks, project)
  }
  appendTasks(unassignedTasks)
  if (!matchingTasks.length && (search || !projects.length)) {
    entries.push({ kind: 'empty', key: 'empty:workspace', message: search ? 'No matching tasks.' : 'No tasks yet.', indented: false })
  }
  return entries
}
