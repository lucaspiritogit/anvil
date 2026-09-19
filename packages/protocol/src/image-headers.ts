import type { TaskImageAttachment } from './types'

export interface ImageHeaders {
  mimeType: TaskImageAttachment['mimeType']
  width: number
  height: number
  animated: boolean
}

/** Container/header validation only. Chromium must still decode user image pixels.
 * PNG: https://www.w3.org/TR/png-3/
 * WebP: https://developers.google.com/speed/webp/docs/riff_container
 */
export function readImageHeaders(bytes: Uint8Array): ImageHeaders {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const require = (condition: boolean): void => { if (!condition) throw new Error('Invalid or truncated image header') }
  const matches = (offset: number, text: string): boolean => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  const result = (mimeType: ImageHeaders['mimeType'], width: number, height: number, animated = false): ImageHeaders => {
    require(width > 0 && height > 0)
    return { mimeType, width, height, animated }
  }

  if (matches(0, '\x89PNG\r\n\x1a\n')) {
    let width = 0, height = 0, animated = false, data = false
    for (let offset = 8; offset < bytes.length;) {
      require(offset + 12 <= bytes.length)
      const size = view.getUint32(offset)
      const end = offset + size + 12
      require(end <= bytes.length)
      if (offset === 8) {
        require(matches(offset + 4, 'IHDR') && size === 13)
        width = view.getUint32(offset + 8)
        height = view.getUint32(offset + 12)
        const depth = bytes[offset + 16], color = bytes[offset + 17]
        const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
        require(Boolean(depths[color]?.includes(depth)) && bytes[offset + 18] === 0 && bytes[offset + 19] === 0 && bytes[offset + 20] <= 1)
      } else require(!matches(offset + 4, 'IHDR'))
      if (matches(offset + 4, 'acTL') || matches(offset + 4, 'fcTL') || matches(offset + 4, 'fdAT')) animated = true
      if (matches(offset + 4, 'IDAT') && size > 0) data = true
      if (matches(offset + 4, 'IEND')) {
        require(size === 0 && data && end === bytes.length)
        return result('image/png', width, height, animated)
      }
      offset = end
    }
    throw new Error('PNG is missing its end chunk')
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let width = 0, height = 0, scanned = false
    for (let offset = 2; offset < bytes.length;) {
      require(bytes[offset++] === 0xff)
      while (bytes[offset] === 0xff) offset++
      require(offset < bytes.length)
      const marker = bytes[offset++]
      if (marker === 0xd9) {
        require(scanned)
        return result('image/jpeg', width, height)
      }
      require(marker !== 0 && marker !== 0xd8 && !(marker >= 0xd0 && marker <= 0xd7))
      require(offset + 2 <= bytes.length)
      const size = view.getUint16(offset)
      require(size >= 2 && offset + size <= bytes.length)
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        require(size >= 8 && !width)
        height = view.getUint16(offset + 3)
        width = view.getUint16(offset + 5)
        require(size === 8 + 3 * bytes[offset + 7])
      }
      offset += size
      if (marker === 0xda) {
        require(width > 0 && height > 0)
        scanned = true
        // Skip entropy bytes, escaped FF bytes and restart markers. Progressive
        // JPEG may have more scan/metadata segments before its end marker.
        while (offset < bytes.length) {
          if (bytes[offset] !== 0xff) { offset++; continue }
          if (bytes[offset + 1] === 0 || (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7)) { offset += 2; continue }
          break
        }
      }
    }
    throw new Error('JPEG is missing its end marker')
  }

  if (matches(0, 'RIFF') && matches(8, 'WEBP')) {
    require(bytes.length >= 20 && view.getUint32(4, true) + 8 === bytes.length)
    let width = 0, height = 0, animated = false, frame = false, extended = false
    const uint24 = (offset: number): number => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536
    for (let offset = 12; offset < bytes.length;) {
      require(offset + 8 <= bytes.length)
      const size = view.getUint32(offset + 4, true)
      const start = offset + 8, end = start + size + size % 2
      require(end <= bytes.length)
      if (matches(offset, 'VP8X')) {
        require(offset === 12 && size === 10)
        extended = true
        animated = Boolean(bytes[start] & 2)
        width = uint24(start + 4) + 1
        height = uint24(start + 7) + 1
      } else if (matches(offset, 'ANIM') || matches(offset, 'ANMF')) {
        animated = true
      } else if (matches(offset, 'VP8 ') || matches(offset, 'VP8L')) {
        require(!frame)
        frame = true
        let frameWidth: number, frameHeight: number
        if (matches(offset, 'VP8 ')) {
          require(size >= 10 && !(bytes[start] & 1) && matches(start + 3, '\x9d\x01\x2a'))
          frameWidth = view.getUint16(start + 6, true) & 0x3fff
          frameHeight = view.getUint16(start + 8, true) & 0x3fff
        } else {
          require(size >= 5 && bytes[start] === 0x2f)
          const bits = view.getUint32(start + 1, true)
          require(bits >>> 29 === 0)
          frameWidth = (bits & 0x3fff) + 1
          frameHeight = ((bits >>> 14) & 0x3fff) + 1
        }
        if (extended) require(width === frameWidth && height === frameHeight)
        else { width = frameWidth; height = frameHeight }
      }
      offset = end
    }
    require(frame || animated)
    return result('image/webp', width, height, animated)
  }
  throw new Error('Use a valid PNG, JPEG or WebP image')
}

export function validateImageHeaders(bytes: Uint8Array, limits: { pixels: number; dimension?: number; mimeType?: string }): ImageHeaders {
  const image = readImageHeaders(bytes)
  if (limits.mimeType && image.mimeType !== limits.mimeType) throw new Error('The MIME type does not match the encoded image')
  if (image.animated) throw new Error('Animated images are not supported; paste a still image')
  if (image.width * image.height > limits.pixels) throw new Error(`Images must be at most ${limits.pixels / 1_000_000} million pixels`)
  if (limits.dimension && Math.max(image.width, image.height) > limits.dimension) {
    throw new Error('Image dimensions exceed the supported limit')
  }
  return image
}
