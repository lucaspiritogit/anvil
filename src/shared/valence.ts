/** Stable ownership marker for issues created by an Anvil planning agent. */
export function taskIssueLabel(taskId: string): string {
  return `anvil-task:${taskId}`
}
