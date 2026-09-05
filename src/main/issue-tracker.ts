import { randomBytes } from 'node:crypto'
import type { Issue, IssueTracker } from '../shared/types'

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Issue ${name} must contain text`)
  return value.trim()
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Issue ${name} must be an array`)
  const values = value.map((entry) => required(entry, name))
  if (new Set(values).size !== values.length) throw new Error(`Issue ${name} must not contain duplicates`)
  return values
}

function parseOutput(text: string): Record<string, unknown> {
  const matches = [...text.matchAll(/<anvil-issue-tracker>([\s\S]*?)<\/anvil-issue-tracker>/g)]
  if (matches.length !== 1) throw new Error('Expected one <anvil-issue-tracker> JSON result from the agent')
  const data = JSON.parse(matches[0][1])
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected an issue tracker object')
  return data
}

export function parsePlan(text: string, limit = 50): Issue[] {
  const data = parseOutput(text)
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > Math.min(limit, 50)) {
    throw new Error('The plan must contain between 1 and 50 issues')
  }
  const ids = new Map<string, string>()
  const items: Issue[] = data.items.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Expected an issue object')
    const key = required(item.key, 'key')
    if (ids.has(key)) throw new Error('Issue keys must be unique')
    const id = randomBytes(8).toString('hex')
    ids.set(key, id)
    const checklist = strings(item.checklist, 'checklist')
    if (!checklist.length) throw new Error('Each issue needs a checklist')
    if (!['urgent', 'high', 'medium', 'low'].includes(item.priority)) throw new Error('Invalid issue priority')
    if (item.status !== 'queued') throw new Error('Planned issues must be queued')
    return {
      id, title: required(item.title, 'title'), description: required(item.description, 'description'),
      checklist, validation: required(item.validation, 'validation'),
      labels: strings(item.labels, 'labels'), priority: item.priority,
      dependencies: strings(item.dependencies, 'dependencies'), status: 'queued'
    }
  })
  for (const item of items) {
    item.dependencies = item.dependencies.map((key) => {
      const id = ids.get(key)
      if (!id) throw new Error(`Unknown issue dependency: ${key}`)
      if (id === item.id) throw new Error('An issue cannot depend on itself')
      return id
    })
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (item: Issue): void => {
    if (visiting.has(item.id)) throw new Error('Issue dependencies must not contain cycles')
    if (visited.has(item.id)) return
    visiting.add(item.id)
    for (const id of item.dependencies) visit(items.find((entry) => entry.id === id)!)
    visiting.delete(item.id)
    visited.add(item.id)
  }
  items.forEach(visit)
  return items
}

/** Dependencies take precedence over priority; plan order breaks priority ties. */
export function nextIssue(tracker: IssueTracker): Issue | undefined {
  const working = tracker.items.find((item) => item.status === 'working')
  if (working) return working
  const completed = new Set(tracker.items.filter((item) => item.status === 'complete').map((item) => item.id))
  const priority = { urgent: 0, high: 1, medium: 2, low: 3 }
  return tracker.items.filter((item) => item.status === 'queued' && item.dependencies.every((id) => completed.has(id)))
    .sort((a, b) => priority[a.priority] - priority[b.priority])[0]
}

export function completionEvidence(text: string, item: Issue): string {
  const data = parseOutput(text)
  if (data.id !== item.id || data.status !== 'complete' || !Array.isArray(data.checklist) ||
    data.checklist.length !== item.checklist.length || !data.checklist.every((value) => value === true)) {
    throw new Error('The agent must complete the current issue and confirm every checklist item')
  }
  return required(data.evidence, 'validation evidence')
}

export function issueTrackerPrompt(tracker: IssueTracker, task: string): string {
  const rules = 'Work sequentially. Do not delegate or run parallel agents. Anvil manages issue status and starts the next ready issue after validation. Do not ask for user approval between issues. End your final message with exactly one <anvil-issue-tracker>JSON</anvil-issue-tracker> block.'
  if (!tracker.items.length) return `${rules}\nInspect the project and plan this task. Do not change files or commit during planning. Choose between 1 and ${tracker.limit} atomic issues; the maximum is not a target. Each issue should change one understandable behavior. Assign a unique temporary key, labels, priority (urgent, high, medium, low), dependencies using other issue keys, and status queued. Dependencies must be acyclic. Anvil replaces keys with stable hashes and executes ready issues by priority, then plan order. Return {"items":[{"key":"setup","title":"...","description":"...","labels":["backend"],"priority":"medium","dependencies":[],"status":"queued","checklist":["..."],"validation":"specific validation steps"}]}.\nTask: ${task}`
  const item = nextIssue(tracker)
  if (!item) throw new Error('No issue is ready to execute')
  return `${rules}\nMain task: ${task}\nIssue tracker: ${JSON.stringify(tracker.items)}\nImplement ONLY this issue: ${JSON.stringify(item)}\nRun its validation and commit its changes. Include a plain-language summary of the change and validation. If this is the final issue, summarize the completed task for the user. Return {"id":"${item.id}","status":"complete","checklist":${JSON.stringify(item.checklist.map(() => true))},"evidence":"commands run, results, and any manual validation details"}. Do not claim checks passed if they failed.`
}
