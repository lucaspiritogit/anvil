import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

/** Bundle the vendored CLI and library, keeping their relative asset lookups intact. */
export async function buildValence(outputDirectory: string): Promise<void> {
  await build({
    entryPoints: {
      'valence/dist/index': 'node_modules/valence/dist/index.js',
      'valence/dist/cli': 'node_modules/valence/dist/cli.js',
      'main/valence-cli': 'src/main/valence/cli.ts'
    },
    outdir: outputDirectory, bundle: true, platform: 'node', format: 'cjs',
    external: ['better-sqlite3', 'drizzle-orm', 'drizzle-orm/*']
  })
  const destination = resolve(outputDirectory, 'valence')
  await mkdir(destination, { recursive: true })
  await cp(resolve('node_modules/valence/drizzle'), resolve(destination, 'drizzle'), { recursive: true })
  await cp(resolve('node_modules/valence/package.json'), resolve(destination, 'package.json'))
}
