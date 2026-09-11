// Reserved for new task checkouts. Titles/prompts must never enter this name.
export const temporaryTaskBranchPrefix = 'anvil-tmp/'

export function temporaryTaskBranch(taskId: string): string {
  return `${temporaryTaskBranchPrefix}${taskId}`
}
