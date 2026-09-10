// Run from the repository root against the actual packaged executable.
// Without --request this only queries settings; --request may show an OS prompt.
const { _electron } = require('@playwright/test')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

async function main() {
  const executable = process.argv[2]
  if (process.platform !== 'darwin' || !executable || executable.startsWith('--')) {
    throw new Error('Usage on macOS: node scripts/probe-mac-notifications.cjs <Anvil.app/Contents/MacOS/Anvil> [--request]')
  }
  const env = {
    ...process.env,
    ANVIL_DATA_DIR: mkdtempSync(join(tmpdir(), 'anvil-notification-probe-')),
    ELECTRON_ENABLE_NOTIFICATION_DEBUGGING: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  console.log('Temporary Anvil data directory:', env.ANVIL_DATA_DIR)
  console.log('This does not reset system notification preferences.')
  const application = await _electron.launch({ executablePath: resolve(executable), env, timeout: 30000 })
  application.process().stdout.on('data', (data) => process.stdout.write(data))
  application.process().stderr.on('data', (data) => process.stderr.write(data))
  let timeout
  try {
    const probe = application.evaluate(async ({ app, Notification }, request) => {
      await app.whenReady()
      const bridge = process.mainModule.require(process.resourcesPath + '/mac-notifications/authorization.node')
      const before = await bridge.authorization(false)
      console.log('Authorization before request:', before)
      const status = request ? await bridge.authorization(true) : before
      const result = { before, status, delivery: 'not attempted' }
      // Do not call isSupported before authorization: it initializes the presenter.
      if (request && (status === 'granted' || status === 'provisional')) {
        result.delivery = await new Promise((resolve) => {
          const notification = new Notification({
            title: 'Anvil notification check', body: 'Confirm this notification is visible on your desktop.'
          })
          globalThis.anvilNotificationProbe = notification
          const timer = setTimeout(() => resolve('timed out'), 10000)
          const finish = (value) => { clearTimeout(timer); resolve(value) }
          notification.once('failed', (_event, error) => finish(`failed: ${error}`))
          notification.once('show', () => finish('scheduled; visible delivery still requires manual confirmation'))
          notification.show()
        })
      }
      return result
    }, process.argv.includes('--request'))
    const result = await Promise.race([
      probe,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Native probe timed out after 45 seconds; no authorization or delivery confirmed')), 45000)
      })
    ])
    console.log(JSON.stringify(result, null, 2))
    console.log('Prompt, denial/re-enable recovery, and foreground/minimized banners require manual verification.')
    if (result.delivery.startsWith('scheduled')) {
      console.log('Keeping the app open for 15 seconds to inspect the notification.')
      await new Promise((resolve) => setTimeout(resolve, 15000))
    }
  } finally {
    clearTimeout(timeout)
    await application.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
