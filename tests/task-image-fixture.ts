import sharp from 'sharp'
import type { TaskImageAttachment } from '../src/shared/types'

export async function taskImages(): Promise<TaskImageAttachment[]> {
  return Promise.all((['png', 'jpeg', 'webp'] as const).map(async (format) => ({
    filename: `clipboard.${format}`,
    mimeType: `image/${format}` as TaskImageAttachment['mimeType'],
    bytes: new Uint8Array(await sharp({ create: { width: 2, height: 3, channels: 3, background: '#731ac4' } }).toFormat(format).toBuffer())
  })))
}
