/** JSON uses base64 only for task image bytes; the in-process contract stays binary. */
export function encodeRpcInput(channel: string, input: unknown): unknown {
  if (channel !== 'tasks:start' || !input || typeof input !== 'object' || !('images' in input) || !Array.isArray(input.images)) return input
  return {
    ...input,
    images: input.images.map((image) => {
      if (!image || !(image.bytes instanceof Uint8Array)) return image
      let binary = ''
      for (let offset = 0; offset < image.bytes.length; offset += 8192) {
        binary += String.fromCharCode(...image.bytes.subarray(offset, offset + 8192))
      }
      return { ...image, bytes: btoa(binary) }
    })
  }
}

export function decodeRpcInput(channel: string, input: unknown): unknown {
  if (channel !== 'tasks:start' || !input || typeof input !== 'object' || !('images' in input) || !Array.isArray(input.images)) return input
  return {
    ...input,
    images: input.images.map((image) => {
      if (!image || typeof image.bytes !== 'string' || image.bytes.length > Math.ceil(10 * 1024 * 1024 / 3) * 4 ||
        image.bytes.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.bytes)) {
        throw new Error('Invalid RPC image bytes: expected base64')
      }
      const binary = atob(image.bytes)
      if (btoa(binary) !== image.bytes) throw new Error('Invalid RPC image bytes: noncanonical base64')
      return { ...image, bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)) }
    })
  }
}
