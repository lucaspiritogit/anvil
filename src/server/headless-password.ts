import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import type { ServerAuth } from './server-auth'

async function promptPassword(prompt: string): Promise<string> {
  // readline still handles editing and Ctrl+C, but never echoes the password.
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) { callback() }
  })
  const terminal = createInterface({ input: process.stdin, output: mutedOutput, terminal: true })
  const closeTerminal = (): void => { terminal.close() }
  process.once('exit', closeTerminal)
  process.stdout.write(prompt)
  try {
    return await new Promise<string>((resolve, reject) => {
      terminal.once('SIGINT', () => reject(new Error('Password entry cancelled.')))
      terminal.once('close', () => reject(new Error('Password entry cancelled.')))
      terminal.question('', resolve)
    })
  } finally {
    process.off('exit', closeTerminal)
    terminal.close()
    mutedOutput.destroy()
    process.stdout.write('\n')
  }
}

export async function configureHeadlessPassword(auth: ServerAuth): Promise<void> {
  const passwordFile = process.env.ANVIL_SERVER_PASSWORD_FILE
  if (passwordFile) {
    const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '')
    await auth.setPassword(password)
    return
  }
  if ((await auth.status()).configured) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Set ANVIL_SERVER_PASSWORD_FILE to a password file, or run once in a terminal to set the Anvil password.')
  }
  const password = await promptPassword('Set Anvil password: ')
  if (!password) throw new Error('Server password must not be empty.')
  const confirmation = await promptPassword('Confirm password: ')
  if (password !== confirmation) throw new Error('Passwords do not match.')
  await auth.setPassword(password)
}
