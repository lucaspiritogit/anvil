import { build } from 'esbuild'

/** Bundle Anvil's CLI without importing the desktop entry point. */
export async function buildValence(outputDirectory: string): Promise<void> {
  await build({
    entryPoints: { 'main/valence-cli': 'src/main/valence/cli.ts' },
    outdir: outputDirectory, bundle: true, platform: 'node', format: 'cjs',
    external: ['better-sqlite3', 'drizzle-orm', 'drizzle-orm/*']
  })
}
