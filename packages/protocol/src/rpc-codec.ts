const binaryChannel = (channel: string): boolean => channel === 'tasks:start' || channel === 'wallpapers:upload'

function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}

function decodeBytes(value: unknown, limit: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 ||
    value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('Invalid RPC image bytes: expected base64')
  }
  const binary = atob(value)
  if (btoa(binary) !== value) throw new Error('Invalid RPC image bytes: noncanonical base64')
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function encodeRpcInput(channel: string, input: unknown): unknown {
  if (!binaryChannel(channel) || !input || typeof input !== 'object') return input
  if (channel === 'wallpapers:upload' && 'bytes' in input && input.bytes instanceof Uint8Array) {
    return { ...input, bytes: encodeBytes(input.bytes) }
  }
  if (!('images' in input) || !Array.isArray(input.images)) return input
  return {
    ...input,
    images: input.images.map((image) => {
      if (!image || !(image.bytes instanceof Uint8Array)) return image
      return { ...image, bytes: encodeBytes(image.bytes) }
    })
  }
}

export function decodeRpcInput(channel: string, input: unknown): unknown {
  if (!binaryChannel(channel) || !input || typeof input !== 'object') return input
  if (channel === 'wallpapers:upload' && 'bytes' in input) {
    return { ...input, bytes: decodeBytes(input.bytes, 10 * 1024 * 1024) }
  }
  if (!('images' in input) || !Array.isArray(input.images)) return input
  return {
    ...input,
    images: input.images.map((image) => {
      if (!image) throw new Error('Invalid RPC image bytes: expected base64')
      return { ...image, bytes: decodeBytes(image.bytes, 10 * 1024 * 1024) }
    })
  }
}
