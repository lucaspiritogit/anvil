import sharp from 'sharp'
import { TASK_IMAGE_LIMITS, type TaskImageAttachment } from '../shared/types'
import { parseTaskImages, TASK_IMAGE_FORMATS } from '../shared/task-images'

export { parseTaskImages } from '../shared/task-images'

/** Read all pixels, not just headers. Bound decoded allocation as well as encoded bytes. */
export async function validateTaskImages(value: unknown): Promise<TaskImageAttachment[]> {
  const images = parseTaskImages(value)
  for (const [index, image] of images.entries()) {
    try {
      const decoder = sharp(image.bytes, { failOn: 'warning', limitInputPixels: TASK_IMAGE_LIMITS.pixels })
      const metadata = await decoder.metadata()
      if (metadata.format !== TASK_IMAGE_FORMATS[image.mimeType]) throw new Error('the MIME type does not match the encoded image')
      if ((metadata.pages ?? 1) > 1) throw new Error('animated images are not supported; paste a still image')
      await decoder.raw().toBuffer()
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : 'image could not be decoded'
      throw new Error(`Invalid image ${index + 1}: ${reason}. Use a valid PNG, JPEG or WebP of at most 16 million pixels.`)
    }
  }
  return images
}
