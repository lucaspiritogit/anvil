import { validateImageHeaders } from '@anvil/protocol/image-headers'
import { TASK_IMAGE_LIMITS, type TaskImageAttachment } from '@anvil/protocol/types'
import { parseTaskImages } from '@anvil/protocol/task-images'

export { parseTaskImages } from '@anvil/protocol/task-images'

/** Bound image headers here; the composer fully decodes pixels with Chromium. */
export async function validateTaskImages(value: unknown): Promise<TaskImageAttachment[]> {
  const images = parseTaskImages(value)
  for (const [index, image] of images.entries()) {
    try {
      validateImageHeaders(image.bytes, { mimeType: image.mimeType, pixels: TASK_IMAGE_LIMITS.pixels })
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : 'image could not be decoded'
      throw new Error(`Invalid image ${index + 1}: ${reason}. Use a valid PNG, JPEG or WebP of at most 16 million pixels.`)
    }
  }
  return images
}
