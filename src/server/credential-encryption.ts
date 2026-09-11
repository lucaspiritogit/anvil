import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CredentialEncryption } from './github-credentials'

/** A single private key belongs to the server data directory. */
export function createCredentialEncryption(keyPath: string): CredentialEncryption {
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  chmodSync(keyPath, 0o600)
  const key = readFileSync(keyPath)
  if (key.length !== 32) throw new Error('Invalid credential encryption key')
  const prefix = Buffer.from('ANVIL1')
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([prefix, nonce, cipher.getAuthTag(), ciphertext])
    },
    decryptString(value) {
      if (value.length < 34 || !value.subarray(0, 6).equals(prefix)) {
        throw new Error('Unsupported credential format. Replace your GitHub token in Settings.')
      }
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(6, 18))
      decipher.setAuthTag(value.subarray(18, 34))
      return Buffer.concat([decipher.update(value.subarray(34)), decipher.final()]).toString('utf8')
    }
  }
}
