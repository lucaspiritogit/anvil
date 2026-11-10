import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'

export function mergeMacManifests(manifests) {
  if (manifests.length === 0) throw new Error('No macOS update manifests to merge.')
  const versions = new Set(manifests.map((manifest) => manifest.version))
  if (versions.size !== 1) throw new Error(`macOS update manifests disagree on version: ${[...versions].join(', ')}`)
  const files = new Map()
  for (const manifest of manifests) {
    if (!Array.isArray(manifest.files)) throw new Error('macOS update manifest has no files.')
    for (const file of manifest.files) files.set(file.url, file)
  }
  const primary = manifests.find((manifest) => !String(manifest.path).includes('arm64')) ?? manifests[0]
  const releaseDate = manifests.map((manifest) => manifest.releaseDate).filter(Boolean).sort().at(-1)
  return { ...primary, files: [...files.values()], ...(releaseDate ? { releaseDate } : {}) }
}

async function main() {
  const directory = resolve(process.argv[2] ?? 'updates')
  const names = (await readdir(directory)).filter((name) => /^latest-mac-.+\.yml$/.test(name)).sort()
  if (names.length === 0) {
    console.log('No per-architecture macOS update manifests found.')
    return
  }
  const manifests = await Promise.all(names.map(async (name) => yaml.load(await readFile(join(directory, name), 'utf8'))))
  await writeFile(join(directory, 'latest-mac.yml'), yaml.dump(mergeMacManifests(manifests), { lineWidth: -1 }))
  await Promise.all(names.map((name) => rm(join(directory, name))))
  console.log(`Merged ${names.join(', ')} into latest-mac.yml`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
