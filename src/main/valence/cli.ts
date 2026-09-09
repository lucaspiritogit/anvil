import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { openCliTracker } from './connection'
import { help } from './cli-help'
import type { Completion, CreateIssue, CreateParentIssue, UpdateIssue, UpdateParentIssue } from '../../shared/valence'

const issueOptions = ['parent', 'description', 'checklist', 'validation', 'label', 'priority', 'dependency']
const commands: Record<string, string[]> = {
  init: [], status: [], 'parent create': ['anvil-task-id', 'description', 'file'],
  'parent update': ['title', 'description', 'file'], 'parent show': [], 'parent list': [],
  create: [...issueOptions, 'file'], update: [...issueOptions, 'title', 'file'],
  show: [], list: ['parent'], ready: ['parent'], claim: ['parent'], start: [],
  complete: ['evidence', 'confirm-checklist', 'file'], block: [], requeue: []
}
const jsonOutput = process.argv.slice(2).includes('--json')
function output(value: unknown): void {
  console.log(typeof value === 'string' && !jsonOutput ? value : JSON.stringify(value ?? null, null, jsonOutput ? undefined : 2))
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      local: { type: 'boolean' }, config: { type: 'boolean' }, project: { type: 'string' },
      'anvil-task-id': { type: 'string' }, parent: { type: 'string' }, file: { type: 'string' },
      title: { type: 'string' }, description: { type: 'string' }, validation: { type: 'string' },
      checklist: { type: 'string', multiple: true }, label: { type: 'string', multiple: true },
      dependency: { type: 'string', multiple: true }, priority: { type: 'string' },
      evidence: { type: 'string' }, 'confirm-checklist': { type: 'boolean' }
    }
  })
  if (values.local || values.config) throw new Error('--local and --config are obsolete. Use the Anvil launcher and --project <registered directory>; open Anvil to initialize storage')
  if (values.version) { output(jsonOutput ? { version: '0.1.0' } : '0.1.0'); return }
  let command = positionals.shift() ?? 'help'
  if (command === 'parent') command += ` ${positionals.shift() ?? ''}`
  if (values.help || command === 'help') {
    output(jsonOutput ? { help, commands: Object.fromEntries(Object.entries(commands).map(([name, options]) => [name, { options: [...options, 'project', 'json', 'help'] }])) } : help)
    return
  }
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command: ${command}. Run vl --help`)
  const allowed = [...commands[command], 'project', 'json', 'help']
  for (const option of Object.keys(values)) if (!allowed.includes(option)) throw new Error(`Option --${option} is not supported by ${command}`)
  const creates = command === 'create' || command === 'parent create'
  const takesId = ['update', 'show', 'start', 'complete', 'block', 'requeue', 'parent show', 'parent update'].includes(command)
  const expected = takesId || (creates && values.file === undefined) ? 1 : 0
  if (positionals.length !== expected) throw new Error(`vl ${command} requires ${expected} positional argument(s). Run vl --help`)
  if (values.file !== undefined && Object.keys(values).some((key) => !['file', 'json', 'help', 'project'].includes(key))) {
    throw new Error('--file cannot be combined with field or completion flags')
  }
  const input: unknown = values.file !== undefined ? JSON.parse(readFileSync(values.file, 'utf8')) : Object.fromEntries(Object.entries({
    title: creates ? positionals[0] : values.title, anvilTaskId: values['anvil-task-id'], parentId: values.parent,
    description: values.description, checklist: values.checklist, validation: values.validation,
    labels: values.label, priority: values.priority, dependencies: values.dependency
  }).filter(([, value]) => value !== undefined))
  const tracker = openCliTracker(values.project ?? process.cwd())
  try {
    let result: unknown
    const id = positionals[0]
    switch (command) {
      case 'status': case 'init': result = { initialized: true, database: tracker.databasePath, projectId: tracker.projectId }; break
      case 'parent create': result = tracker.createParent(input as CreateParentIssue); break
      case 'parent update': result = tracker.updateParent(id, input as UpdateParentIssue); break
      case 'parent show': result = tracker.getParent(id); break
      case 'parent list': result = tracker.listParents(); break
      case 'create': result = tracker.create(input as CreateIssue); break
      case 'update': result = tracker.update(id, input as UpdateIssue); break
      case 'show': result = tracker.get(id); break
      case 'list': result = tracker.list(values.parent); break
      case 'ready': result = tracker.ready(values.parent); break
      case 'claim': result = tracker.claim(values.parent === undefined ? undefined : { parentId: values.parent }); break
      case 'start': case 'block': case 'requeue': result = tracker[command](id); break
      case 'complete':
        if (!values.file && !values['confirm-checklist']) throw new Error('Use --confirm-checklist or --file with checklist confirmations')
        result = tracker.complete(id, values.file ? input as Completion : {
          checklist: tracker.get(id).checklist.map(() => true), evidence: values.evidence as string
        })
        break
    }
    output(result)
  } finally {
    tracker.close()
  }
}

try { main() } catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(jsonOutput ? JSON.stringify({ error: message }) : `vl: ${message}`)
  process.exitCode = 1
}
