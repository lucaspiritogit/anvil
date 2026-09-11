import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)

function git(args, capture = false) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
  })?.trim()
}

try {
  if (args.length !== 1 || args[0].startsWith('-')) {
    throw new Error('Usage: npm run release -- <patch|minor|major|version>')
  }
  if (!process.env.npm_execpath) {
    throw new Error('Run this script through npm: npm run release -- patch')
  }
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true)
  if (git(['status', '--porcelain'], true)) {
    throw new Error('Commit or stash all changes before creating a release.')
  }
  git(['remote', 'get-url', 'origin'], true)

  execFileSync(process.execPath, [
    process.env.npm_execpath,
    'version', args[0],
    '--git-tag-version=true',
    '--tag-version-prefix=v',
    '--message=chore: release %s'
  ], { cwd, stdio: 'inherit' })

  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const tag = `v${version}`
  try {
    git(['push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`])
  } catch (error) {
    console.error(`Release ${tag} exists locally. After fixing the push failure, retry:`)
    console.error(`git push --atomic origin HEAD:refs/heads/${branch} refs/tags/${tag}`)
    throw error
  }
  console.log(`Pushed ${tag}. GitHub Actions will build and publish the release.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
