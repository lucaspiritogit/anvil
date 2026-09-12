const { spawn } = require('node:child_process')
const { resolve } = require('node:path')

const serveArguments = process.argv.slice(2)
for (const argument of serveArguments) {
  if (argument !== '--headless' && argument !== '--tailscale') {
    throw new Error(`Unknown serve argument: ${argument}`)
  }
}
const headless = serveArguments.includes('--headless')
const tailscale = serveArguments.includes('--tailscale')
const executable = headless ? process.execPath : require('electron')
const environment = { ...process.env }
if (headless) {
  delete environment.ELECTRON_RUN_AS_NODE
  const { prepareHeadlessSqlite } = require('./prepare-headless-native.cjs')
  environment.ANVIL_SQLITE_BINDING = prepareHeadlessSqlite()
} else {
  delete environment.ANVIL_SQLITE_BINDING
  environment.ELECTRON_RUN_AS_NODE = '1'
}

const server = spawn(executable, [resolve('out/server/index.js'), ...serveArguments], {
  stdio: [headless && !tailscale ? 'inherit' : 'ignore', 'inherit', 'inherit', 'ipc'],
  env: environment
})

let stopping = false
let shutdownDeadline

function stop() {
  if (stopping || server.exitCode !== null || server.signalCode !== null) return
  stopping = true
  console.log('Stopping Anvil server…')
  // Let the server finish its eight-second cleanup deadline first.
  shutdownDeadline = setTimeout(() => server.kill('SIGKILL'), 10_000)
  server.kill('SIGTERM')
}

function cleanup() {
  clearTimeout(shutdownDeadline)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.on('SIGHUP', stop)

server.on('message', (message) => {
  if (message?.type === 'anvil-server-ready' && process.stdin.isTTY && !stopping) {
    console.log('Press Ctrl+C to stop.')
  }
})
server.on('error', (error) => {
  cleanup()
  console.error(error)
  process.exitCode = 1
})
server.on('exit', (code) => {
  cleanup()
  process.exitCode = code ?? 1
})
