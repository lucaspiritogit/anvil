import { useEffect, useRef, useState } from 'react'
import { validateImageHeaders } from '@anvil/protocol/image-headers'
import { parseTaskImages, TASK_IMAGE_FORMATS } from '@anvil/protocol/task-images'
import { TASK_IMAGE_LIMITS, type TaskImageAttachment } from '@anvil/protocol/types'

interface ComposerImage {
  id: number
  filename: string
  size: number
  status: 'reading' | 'ready' | 'error'
  image?: TaskImageAttachment
  preview?: string
  error?: string
}

interface ImageInput {
  file: File | null
  mimeType: string
  pasted: boolean
}

async function readImage(file: File): Promise<TaskImageAttachment> {
  const [image] = parseTaskImages([{
    filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer())
  }])
  validateImageHeaders(image.bytes, { mimeType: image.mimeType, pixels: TASK_IMAGE_LIMITS.pixels })
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
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
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
    setAttachmentError(null)
  }

  const ingest = (inputs: readonly ImageInput[]): void => {
    setAttachmentError(null)
    for (const input of inputs) {
      if (entries.current.size >= TASK_IMAGE_LIMITS.count) {
        setAttachmentError(`Attach at most ${TASK_IMAGE_LIMITS.count} images. Remove an image before attaching more.`)
        break
      }
      const id = ++nextId.current
      const entry: ComposerImage = { id, filename: input.file?.name || `${input.pasted ? 'Pasted' : 'Attached'} image ${id}`, size: 0, status: 'reading' }
      entries.current.set(id, entry)
      try {
        if (!Object.hasOwn(TASK_IMAGE_FORMATS, input.mimeType)) throw new Error('Attach a PNG, JPEG or WebP image')
        if (!input.file) throw new Error('The clipboard image could not be read. Copy it again and retry.')
        if (input.file.type !== input.mimeType) throw new Error('The clipboard file MIME type does not match the image item')
        const extension = TASK_IMAGE_FORMATS[input.mimeType as TaskImageAttachment['mimeType']]
        const validFilename = input.file.name.trim() && input.file.name.length <= 255 && !/[\\/\x00-\x1f\x7f]/.test(input.file.name)
        const filename = validFilename ? input.file.name : input.pasted ? `pasted-image-${id}.${extension}` : input.file.name
        const file = filename === input.file.name ? input.file : new File([input.file], filename, { type: input.mimeType })
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
        entry.error = error instanceof Error ? error.message : 'The image could not be read'
      }
    }
    setImages([...entries.current.values()])
  }

  const attach = (files: readonly File[]): void => {
    ingest(files.map((file) => ({ file, mimeType: file.type, pasted: false })))
  }

  const paste = (items: DataTransferItemList): void => {
    ingest(Array.from(items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => ({ file: item.getAsFile(), mimeType: item.type, pasted: true })))
  }

  return {
    images, attachmentError, attach, paste, remove,
    pending: images.some((image) => image.status === 'reading'),
    ready: images.flatMap((entry) => entry.image ? [entry.image] : []),
    reset: (): void => { clear(); setImages([]); setAttachmentError(null) }
  }
}
