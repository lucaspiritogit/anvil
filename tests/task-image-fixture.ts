import { imageFixture } from './image-fixtures'
import type { TaskImageAttachment } from '../src/shared/types'

export async function taskImages(): Promise<TaskImageAttachment[]> {
  return Promise.all((['png', 'jpeg', 'webp'] as const).map(async (format) => ({
    filename: `clipboard.${format}`,
    mimeType: `image/${format}` as TaskImageAttachment['mimeType'],
    bytes: new Uint8Array(imageFixture(`sample.${format}`))
  })))
}
