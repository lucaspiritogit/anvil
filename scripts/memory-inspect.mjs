import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import pg from 'pg'

const { Pool } = pg

function parseArguments(arguments_) {
  const options = { projectId: undefined, limit: 20, json: false }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--json') {
      options.json = true
    } else if (argument === '--project') {
      options.projectId = requiredValue(arguments_, ++index, '--project')
    } else if (argument === '--limit') {
      const limit = Number(requiredValue(arguments_, ++index, '--limit'))
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new Error('--limit must be an integer between 1 and 500')
      }
      options.limit = limit
    } else if (argument === '--help' || argument === '-h') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function requiredValue(arguments_, index, option) {
  const value = arguments_[index]
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function printUsage() {
  console.log(`Usage: npm run memory:inspect -- [options]

Options:
  --project <id>  Show memories for one project
  --limit <n>     Maximum rows to return (default 20, maximum 500)
  --json          Print machine-readable JSON
  --help          Show this help

The backend follows ANVIL_MEMORY_BACKEND and defaults to pglite.
Quit Anvil before inspecting PGlite because its data directory has one owner.`)
}

function inspectionQuery(options) {
  const parameters = []
  const whereClause = options.projectId
    ? `WHERE project_id = $${parameters.push(options.projectId)}`
    : ''
  const limitParameter = `$${parameters.push(options.limit)}`
  return {
    text: `
      SELECT
        id,
        project_id,
        source_task_id,
        kind,
        content,
        metadata,
        vector_dims(embedding) AS embedding_dimensions,
        created_at,
        updated_at
      FROM project_memories
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ${limitParameter}
    `,
    parameters
  }
}

async function inspectPglite(options) {
  const dataDirectory =
    process.env.ANVIL_MEMORY_PGLITE_DIR ??
    join(homedir(), '.anvil-composer', 'memory', 'pglite')
  const database = await PGlite.create(dataDirectory, { extensions: { vector } })
  try {
    const query = inspectionQuery(options)
    const result = await database.query(query.text, query.parameters)
    return { rows: result.rows, source: dataDirectory }
  } finally {
    await database.close()
  }
}

async function inspectPostgres(options) {
  const databaseUrl = process.env.ANVIL_MEMORY_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('ANVIL_MEMORY_DATABASE_URL is required for the postgres backend')
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    const query = inspectionQuery(options)
    const result = await pool.query(query.text, query.parameters)
    return { rows: result.rows, source: 'ANVIL_MEMORY_DATABASE_URL' }
  } finally {
    await pool.end()
  }
}

function printRows(rows, source, asJson) {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  console.log(`Project memories: ${rows.length} row(s) from ${source}`)
  for (const row of rows) {
    const title = row.metadata?.title ?? '(untitled)'
    console.log(`\n[${row.updated_at}] ${title}`)
    console.log(`id=${row.id} project=${row.project_id} task=${row.source_task_id}`)
    console.log(`kind=${row.kind} embedding=${row.embedding_dimensions} dimensions`)
    console.log(row.content)
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const backend = process.env.ANVIL_MEMORY_BACKEND ?? 'pglite'
  if (backend === 'disabled') throw new Error('Project memory is disabled')
  if (backend !== 'pglite' && backend !== 'postgres') {
    throw new Error(`Unknown project memory backend: ${backend}`)
  }

  const result =
    backend === 'postgres' ? await inspectPostgres(options) : await inspectPglite(options)
  printRows(result.rows, result.source, options.json)
}

main().catch((error) => {
  console.error(`Could not inspect project memory: ${error.message}`)
  process.exitCode = 1
})
