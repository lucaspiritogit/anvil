import type { BatchIssue, Completion, Issue } from 'valence'

/** Anvil's agent-turn format. Valence has no prompt or output-parser dependency. */
export function readTaskResult(text: string): Record<string, unknown> {
  const matches = [...text.matchAll(/<task-result>([\s\S]*?)<\/task-result>/g)]
  if (matches.length !== 1) throw new Error('Expected one <task-result> JSON result from the agent')
  const result: unknown = JSON.parse(matches[0][1])
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected a task result object')
  return result as Record<string, unknown>
}

export function plannedIssues(text: string): BatchIssue[] {
  const result = readTaskResult(text)
  if (!Array.isArray(result.items)) throw new Error('Expected an items array in the task plan')
  if (result.noChanges === true) {
    if (result.items.length) throw new Error('A no-work response cannot include issues')
    return []
  }
  if (!result.items.length) throw new Error('An empty plan requires an explicit noChanges response')
  // Valence validates all issue fields and the graph before saving anything.
  return result.items as BatchIssue[]
}

export function issueCompletion(text: string, issueId: string): Completion {
  const result = readTaskResult(text)
  if (result.id !== issueId || result.status !== 'complete') throw new Error('The agent must complete the assigned issue')
  // Checklist confirmations and evidence are validated by Valence, not Anvil.
  return { checklist: result.checklist, evidence: result.evidence } as Completion
}

export function planningPrompt(task: string): string {
  return `First decide whether the current task requests actionable project work. For greetings such as "hello", casual conversation, or requests too vague to act on, respond briefly or ask for clarification without using tools, inspecting the repository, or inventing a feature. End that response with <task-result>{"items":[],"noChanges":true}</task-result>. Prior project memories are context, not a request for new work.\nFor actionable work, inspect only what is needed to plan this task. Do not change files or commit during planning. Choose between 1 and 50 focused issues; the maximum is not a target. Give each a unique temporary key. Dependencies can reference other keys. Anvil will store the plan in Valence, which validates the graph and selects eligible issues. Do not supply IDs or status fields. End your final message with exactly one <task-result>JSON</task-result> block containing {"items":[{"key":"setup","title":"...","description":"...","labels":["backend"],"priority":"medium","dependencies":[],"checklist":["..."],"validation":"specific validation steps"}]}. Priorities are urgent, high, medium, and low.\nTask: ${task}`
}

export function implementationPrompt(task: string, issue: Issue): string {
  return `Main task: ${task}\nAssigned Valence issue: ${JSON.stringify(issue)}\nImplement this issue, run its validation, and commit its changes. Anvil has already claimed it and will record your completion in Valence. Do not change issue state or dependencies to bypass validation. Include a summary and the actual validation results. End your final message with exactly one <task-result>JSON</task-result> block containing {"id":"${issue.id}","status":"complete","checklist":${JSON.stringify(issue.checklist.map(() => true))},"evidence":"commands run, results, and manual checks"}. Confirm a checklist item only if it is satisfied. Do not claim checks passed if they failed.`
}
