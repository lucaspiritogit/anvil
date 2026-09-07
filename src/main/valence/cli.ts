import { resolve } from 'node:path'

// Only this child runs as Node. Never boot the desktop app to execute a command.
try {
  const arguments_ = process.argv.slice(2)
  if (arguments_[0] === '--project') {
    const projectPath = arguments_[1]
    if (!projectPath || projectPath.startsWith('-')) throw new Error('--project requires a project directory')
    arguments_.splice(0, 2)
    // Input files belong to the caller's cwd, even when storage belongs elsewhere.
    for (let index = 0; index < arguments_.length; index++) {
      if (arguments_[index] === '--file' && arguments_[index + 1]) {
        arguments_[index + 1] = resolve(arguments_[index + 1])
        index++
      } else if (arguments_[index].startsWith('--file=')) {
        arguments_[index] = `--file=${resolve(arguments_[index].slice('--file='.length))}`
      }
    }
    process.chdir(projectPath)
  }
  if (!arguments_.length || arguments_.some((argument) => ['help', '--help', '-h'].includes(argument))) {
    console.log([
      'Anvil: vl <command> [options]',
      'New trackers default to ~/.config/valence/<project-name>/sqlite.db, outside the repository.',
      'Optional: vl --project <directory> <command> selects the original project when running from a worktree.',
      '--project selects project context, not project-local storage. Existing storage is reused.',
      'Anvil initializes the tracker before starting agents. Do not run init or opt into --local for task work.\n'
    ].join('\n'))
  }
  process.argv = [...process.argv.slice(0, 2), ...arguments_]
  require('../valence/dist/cli.js')
} catch (error) {
  console.error(`vl: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
