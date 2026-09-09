// Adapted from @lpirito/valence 0.1.0, by lpirito. Maintained in Anvil.
import type { CreateIssue, CreateParentIssue } from '../../shared/valence'

export function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} must contain text`)
  return value.trim()
}

function textList(value: unknown, name: string): string[] {
  if (!Array.isArray(value))
    throw new Error(`${name} must be an array`)
  const entries = Array.from(value, (entry) => requiredText(entry, name))
  if (new Set(entries).size !== entries.length)
    throw new Error(`${name} must not contain duplicates`)
  return entries
}

export function validateIssueInput(value: unknown): Required<CreateIssue> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an issue object')
  const input = value as Record<string, unknown>
  const fields = ['parentId', 'title', 'description', 'checklist', 'validation', 'labels', 'priority', 'dependencies']
  for (const field of Object.keys(input)) {
    if (!fields.includes(field))
      throw new Error(`Unknown issue field: ${field}`)
  }
  const priority = input.priority === undefined ? 'medium' : input.priority
  if (priority !== 'urgent' && priority !== 'high' && priority !== 'medium' && priority !== 'low') {
    throw new Error('priority must be urgent, high, medium, or low')
  }
  const checklist = textList(input.checklist, 'checklist')
  if (!checklist.length)
    throw new Error('checklist must contain at least one item')
  return {
    parentId: requiredText(input.parentId, 'parentId'),
    title: requiredText(input.title, 'title'),
    description: requiredText(input.description, 'description'),
    checklist,
    validation: requiredText(input.validation, 'validation'),
    labels: textList(input.labels === undefined ? [] : input.labels, 'labels'),
    priority,
    dependencies: textList(input.dependencies === undefined ? [] : input.dependencies, 'dependencies')
  }
}

export function validateParentInput(value: unknown): Required<CreateParentIssue> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a parent issue object')
  const input = value as Record<string, unknown>
  for (const field of Object.keys(input)) {
    if (!['anvilTaskId', 'title', 'description'].includes(field))
      throw new Error(`Unknown parent issue field: ${field}`)
  }
  if (input.description !== undefined && typeof input.description !== 'string')
    throw new Error('description must be text')
  return {
    anvilTaskId: requiredText(input.anvilTaskId, 'anvilTaskId'),
    title: requiredText(input.title, 'title'),
    description: typeof input.description === 'string' ? input.description.trim() : ''
  }
}
