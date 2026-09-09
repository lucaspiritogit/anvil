import { useEffect, useRef, useState } from 'react'
import { parseTaskImages, TASK_IMAGE_FORMATS } from '@shared/task-images'
import { TASK_IMAGE_LIMITS, type TaskImageAttachment } from '@shared/types'

interface ComposerImage {
  id: number
  filename: string
  size: number
  status: 'reading' | 'ready' | 'error'
  image?: TaskImageAttachment
  preview?: string
  error?: string
}

async function readImage(file: File): Promise<TaskImageAttachment> {
  const [image] = parseTaskImages([{
    filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer())
  }])
  const bytes = image.bytes
  const matches = (offset: number, signature: number[]): boolean => signature.every((byte, index) => bytes[offset + index] === byte)
  const png = matches(0, [137, 80, 78, 71, 13, 10, 26, 10])
  const jpeg = matches(0, [255, 216, 255])
  const webp = matches(0, [82, 73, 70, 70]) && matches(8, [87, 69, 66, 80])
  if (!(image.mimeType === 'image/png' ? png : image.mimeType === 'image/jpeg' ? jpeg : webp)) {
    throw new Error('The image bytes do not match its MIME type')
  }
  // Reject animation before the browser can quietly decode just its first frame.
  if (png || webp) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = png ? 8 : 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(png ? offset : offset + 4, webp)
      if (png && matches(offset + 4, [97, 99, 84, 76]) ||
        webp && matches(offset, [86, 80, 56, 88]) && (bytes[offset + 8] & 2)) {
        throw new Error('Animated images are not supported; paste a still image')
      }
      offset += png ? length + 12 : length + 8 + length % 2
    }
  }
  const bitmap = await createImageBitmap(file)
  try {
    if (bitmap.width * bitmap.height > TASK_IMAGE_LIMITS.pixels) {
      throw new Error('Images must be at most 16 million pixels')
    }
  } finally {
    bitmap.close()
  }
  return image
}

export function useComposerImages() {
  const [images, setImages] = useState<ComposerImage[]>([])
  const [pasteError, setPasteError] = useState<string | null>(null)
  const entries = useRef(new Map<number, ComposerImage>())
  const nextId = useRef(0)

  const clear = (): void => {
    for (const entry of entries.current.values()) if (entry.preview) URL.revokeObjectURL(entry.preview)
    entries.current.clear()
  }
  useEffect(() => clear, [])

  const remove = (id: number): void => {
    const entry = entries.current.get(id)
    if (entry?.preview) URL.revokeObjectURL(entry.preview)
    entries.current.delete(id)
    setImages([...entries.current.values()])
    setPasteError(null)
  }

  const paste = (items: DataTransferItemList): void => {
    setPasteError(null)
    for (const item of Array.from(items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      if (entries.current.size >= TASK_IMAGE_LIMITS.count) {
        setPasteError(`Attach at most ${TASK_IMAGE_LIMITS.count} images. Remove an image before pasting more.`)
        break
      }
      const id = ++nextId.current
      const entry: ComposerImage = { id, filename: `Pasted image ${id}`, size: 0, status: 'reading' }
      entries.current.set(id, entry)
      try {
        if (!Object.hasOwn(TASK_IMAGE_FORMATS, item.type)) throw new Error('Paste a PNG, JPEG or WebP image')
        const clipboardFile = item.getAsFile()
        if (!clipboardFile) throw new Error('The clipboard image could not be read. Copy it again and retry.')
        if (clipboardFile.type !== item.type) throw new Error('The clipboard file MIME type does not match the image item')
        const extension = TASK_IMAGE_FORMATS[item.type as TaskImageAttachment['mimeType']]
        const filename = clipboardFile.name.trim() && clipboardFile.name.length <= 255 && !/[\\/\x00-\x1f\x7f]/.test(clipboardFile.name)
          ? clipboardFile.name : `pasted-image-${id}.${extension}`
        const file = filename === clipboardFile.name ? clipboardFile : new File([clipboardFile], filename, { type: item.type })
        entry.filename = filename
        if (!file.size || file.size > TASK_IMAGE_LIMITS.perImageBytes) throw new Error('Images must be nonempty and at most 10 MiB each')
        const total = [...entries.current.values()].reduce((sum, image) => sum + image.size, 0)
        if (total + file.size > TASK_IMAGE_LIMITS.totalBytes) throw new Error('Combined image bytes must be at most 20 MiB')
        entry.size = file.size
        void readImage(file).then((image) => {
          if (entries.current.get(id) !== entry) return
          // Validate the actual bytes together, including other completed reads.
          parseTaskImages([...entries.current.values()].flatMap((entry) => entry.image ? [entry.image] : []).concat(image))
          entry.preview = URL.createObjectURL(file)
          entry.image = image
          entry.status = 'ready'
          setImages([...entries.current.values()])
        }).catch((error: unknown) => {
          if (entries.current.get(id) !== entry) return
          entry.status = 'error'
          entry.size = 0
          entry.error = error instanceof Error ? error.message : 'The image could not be read'
          setImages([...entries.current.values()])
        })
      } catch (error) {
        entry.status = 'error'
        entry.size = 0
        entry.error = error instanceof Error ? error.message : 'The clipboard image could not be read'
      }
    }
    setImages([...entries.current.values()])
  }

  return {
    images, pasteError, paste, remove,
    pending: images.some((image) => image.status === 'reading'),
    ready: images.flatMap((entry) => entry.image ? [entry.image] : []),
    reset: (): void => { clear(); setImages([]); setPasteError(null) }
  }
}
