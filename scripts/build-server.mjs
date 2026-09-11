import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'out/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  plugins: [{
    name: 'electron-free-server',
    setup(builder) {
      builder.onResolve({ filter: /^electron(?:\/|$)/ }, () => ({ errors: [{ text: 'The server cannot import Electron' }] }))
    }
  }]
})
for (const folder of ['db', 'memory']) {
  await mkdir(`out/server/${folder}`, { recursive: true })
  await cp(`src/server/${folder}/migrations`, `out/server/${folder}/migrations`, { recursive: true })
}
