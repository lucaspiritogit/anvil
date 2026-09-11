import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { projectFileParts } from './project-files'

/** Validate only metadata. Never read or copy referenced file contents. */
export async function validateTaskFileReferences(projectPath: string, paths: readonly string[]): Promise<void> {
  const root = await realpath(projectPath)
  for (const path of new Set(paths)) {
    const parts = projectFileParts(path)
    if (!parts) throw new Error(`Invalid project file reference: ${JSON.stringify(path)}`)
    try {
      let current = root
      for (const [index, part] of parts.entries()) {
        current = join(current, part)
        const stat = await lstat(current)
        if (stat.isSymbolicLink() || !(index === parts.length - 1 ? stat.isFile() : stat.isDirectory())) throw new Error('Unavailable')
      }
      if (await realpath(current) !== current || await realpath(projectPath) !== root) throw new Error('Project changed')
    } catch {
      throw new Error(`Referenced file is missing or unavailable: ${JSON.stringify(path)}. Remove the reference or choose the file again.`)
    }
  }
}

export function promptWithFileReferences(prompt: string, projectPath: string, paths: readonly string[]): string {
  if (!paths.length) return prompt
  return [
    prompt,
    'Selected project file references (JSON paths, no file contents):',
    JSON.stringify([...new Set(paths)]),
    `Original project directory: ${JSON.stringify(projectPath)}.`,
    'Resolve these paths relative to the task working directory, including when it is a Git worktree. For non-Git tasks this is the original project directory.',
    'Check that each file exists before using it. Untracked files and uncommitted edits may exist only in the original project or differ from the task copy. If a task copy is absent, report it or explicitly use the original project file as reference material. Do not assume it was copied into the worktree.'
  ].join('\n\n')
}
