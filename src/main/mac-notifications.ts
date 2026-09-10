import { app, dialog, shell } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { NotificationAuthorization, NotificationDeliveryOptions } from './notification-delivery'

interface AuthorizationBridge {
  authorization(request: boolean): Promise<NotificationAuthorization>
}

let bridge: AuthorizationBridge | undefined
function authorization(request: boolean): Promise<NotificationAuthorization> {
  const requireNative = createRequire(join(app.getAppPath(), 'package.json'))
  bridge ??= requireNative(app.isPackaged
    ? join(process.resourcesPath, 'mac-notifications', 'authorization.node')
    : join(app.getAppPath(), 'native/mac-notifications/build/Release/authorization.node')) as AuthorizationBridge
  return bridge.authorization(request)
}

export async function openNotificationSettings(): Promise<void> {
  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension')
  } catch (error) {
    console.warn('Could not open notification settings:', error)
    await dialog.showMessageBox({
      type: 'info', message: 'Open System Settings → Notifications → Anvil',
      detail: 'Enable Allow Notifications and choose a banner or alert style. Focus modes can silence notifications.'
    })
  }
}

export async function showNotificationSettings(): Promise<void> {
  let status: string
  try { status = await authorization(false) } catch (error) { status = `unavailable (${String(error)})` }
  const { response } = await dialog.showMessageBox({
    type: 'info', message: 'Anvil notifications',
    detail: `macOS authorization: ${status}.\n\nAnvil asks for permission when the first task notification is ready. Enable Allow Notifications in System Settings → Notifications → Anvil. Check banner style and Focus if alerts are silent.\n\n${app.isPackaged ? 'If Anvil is missing from the list, use a signed Anvil build.' : 'Development runs use Electron’s identity. Use a signed packaged Anvil build to verify permissions and delivery.'}`,
    buttons: ['Open System Settings', 'Close'], cancelId: 1
  })
  if (response === 0) await openNotificationSettings()
}

export function macNotificationOptions(): NotificationDeliveryOptions {
  if (process.platform !== 'darwin') return {}
  return {
    authorize: () => authorization(true),
    onUnavailable: async (reason) => {
      const { response } = await dialog.showMessageBox({
        type: 'warning', message: 'Anvil could not send a notification',
        detail: `${reason}\n\nEnable Anvil in System Settings → Notifications. If Anvil is missing, use a signed packaged build. You can reopen these settings from Anvil → Notifications…. Task execution will continue.`,
        buttons: ['Open System Settings', 'Dismiss'], cancelId: 1
      })
      if (response === 0) await openNotificationSettings()
    }
  }
}
