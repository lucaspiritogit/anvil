import { TASK_IMAGE_LIMITS, type TaskImageAttachment } from './types'

export const TASK_IMAGE_FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' } as const

/** Reject untrusted renderer data and take ownership of an independent byte snapshot. */
export function parseTaskImages(value: unknown, field = 'images'): TaskImageAttachment[] {
  const invalid = (message: string): never => { throw new Error(`Invalid ${field}: ${message}`) }
  if (!Array.isArray(value) || value.length > TASK_IMAGE_LIMITS.count) {
    return invalid(`provide an array of at most ${TASK_IMAGE_LIMITS.count} images`)
  }
  let total = 0
  return Array.from(value, (entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null)) {
      return invalid(`image ${index + 1} must contain filename, mimeType and bytes`)
    }
    const image = entry as Record<string, unknown>
    if (Object.keys(image).some((key) => !['filename', 'mimeType', 'bytes'].includes(key))) return invalid(`image ${index + 1} has unknown fields`)
    if (typeof image.filename !== 'string' || !image.filename.trim() || image.filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(image.filename)) {
      return invalid(`image ${index + 1} needs a filename without directory separators, up to 255 characters`)
    }
    if (typeof image.mimeType !== 'string' || !Object.hasOwn(TASK_IMAGE_FORMATS, image.mimeType)) {
      return invalid(`image ${index + 1} must be PNG, JPEG or WebP with its matching image MIME type`)
    }
    if (!(image.bytes instanceof Uint8Array) || !(image.bytes.buffer instanceof ArrayBuffer) ||
      !image.bytes.byteLength || image.bytes.byteLength > TASK_IMAGE_LIMITS.perImageBytes) {
      return invalid(`image ${index + 1} bytes must be a nonempty Uint8Array of at most 10 MiB`)
    }
    total += image.bytes.byteLength
    if (total > TASK_IMAGE_LIMITS.totalBytes) return invalid('combined image bytes must be at most 20 MiB')
    return { filename: image.filename, mimeType: image.mimeType as TaskImageAttachment['mimeType'], bytes: new Uint8Array(image.bytes) }
  })
}

/** Both the composer and IPC require text or at least one validated image. */
export function hasTaskContent(prompt: string, images: readonly TaskImageAttachment[] = []): boolean {
  return Boolean(prompt.trim() || images.length)
}
