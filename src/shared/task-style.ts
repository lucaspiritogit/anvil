import type { Task, TaskStyle } from './types'

export const TASK_STYLES: readonly TaskStyle[] = ['work', 'quick']

export const TASK_STYLE_LABELS: Record<TaskStyle, string> = {
  work: 'Work',
  quick: 'Quick'
}

export function taskStyle(task: Pick<Task, 'style'>): TaskStyle {
  return task.style ?? 'work'
}

export function nextTaskStyle(style: TaskStyle): TaskStyle {
  return TASK_STYLES[(TASK_STYLES.indexOf(style) + 1) % TASK_STYLES.length]
}
