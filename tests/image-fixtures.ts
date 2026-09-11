import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function imageFixture(name = 'sample.png'): Buffer {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'images', name))
}

/** Header-only fixture for testing bounds without allocating huge pixel buffers. */
export function pngWithDimensions(width: number, height: number): Buffer {
  const bytes = imageFixture()
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}
