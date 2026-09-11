const { spawn } = require('node:child_process')
const { resolve } = require('node:path')
const server = spawn(require('electron'), [resolve('out/server/index.js')], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal))
server.on('error', (error) => { console.error(error); process.exitCode = 1 })
server.on('exit', (code) => { process.exitCode = code ?? 1 })
