import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  publicDir: false,
  // Keep artwork URLs inspectable by the browser asset-identity assertions.
  build: { assetsInlineLimit: 0 },
  plugins: [{
    // Commit probes exist only in the browser fixture build. No production hooks
    // or counters, and no Profiler ancestor that also counts descendant updates.
    name: 'task-output-commit-probes',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/components\/(TaskView|TaskOutput|TaskSteeringComposer)\.tsx$/.test(id)) return
      const instrumented = code.replace(
        /(function (TaskView|TaskOutput|TaskSteeringComposer|PatchFiles)\([\s\S]*?\): JSX\.Element \{)/g,
        (declaration, _match, name) => `${declaration}\n__outputCommit(() => {
          if (!new URLSearchParams(location.search).has('renderProbe')) return
          window.outputCommits ??= {}
          window.outputCommits['${name}'] = (window.outputCommits['${name}'] ?? 0) + 1
        })`
      )
      return { code: `import { useLayoutEffect as __outputCommit } from 'react'\n${instrumented}`, map: null }
    }
  }, react(), tailwindcss()],
  resolve: { alias: { '@shared': resolve('src/shared'), '@public': resolve('public') } },
  server: { host: '127.0.0.1', port: 4174, strictPort: true }
})
