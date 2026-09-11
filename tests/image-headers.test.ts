import { expect, test } from 'vitest'
import { readImageHeaders, validateImageHeaders } from '../src/shared/image-headers'
import { validateTaskImages } from '../src/server/task-images'
import { imageFixture, pngWithDimensions } from './image-fixtures'

test.each(['sample.png', 'sample.jpeg', 'progressive.jpeg', 'sample.webp', 'lossless.webp'])('reads %s dimensions from bounded headers', (name) => {
  const bytes = imageFixture(name)
  const mimeType = `image/${name.split('.').at(-1)}`
  expect(readImageHeaders(bytes)).toEqual({ width: 4, height: 3, mimeType, animated: false })
  // A view into a larger allocation must not read outside its own bounds.
  const wrapped = Buffer.concat([Buffer.alloc(9), bytes, Buffer.alloc(9)])
  expect(readImageHeaders(wrapped.subarray(9, -9))).toEqual(readImageHeaders(bytes))
  for (let size = 0; size < bytes.length; size++) {
    expect(() => readImageHeaders(bytes.subarray(0, size)), `truncated at ${size}`).toThrow()
  }
})

test('rejects MIME mismatches, zero dimensions, pixel and dimension limits', async () => {
  expect(() => validateImageHeaders(imageFixture(), { mimeType: 'image/jpeg', pixels: 100 })).toThrow(/MIME/)
  for (const [width, height] of [[0, 3], [4, 0], [8193, 1], [4001, 4000], [0xffffffff, 0xffffffff]]) {
    expect(() => validateImageHeaders(pngWithDimensions(width, height), { pixels: 16_000_000, dimension: 8192 })).toThrow()
  }
  expect(validateImageHeaders(pngWithDimensions(4000, 4000), { pixels: 16_000_000 }).width).toBe(4000)
  await expect(validateTaskImages([{ filename: 'bad.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }])).rejects.toThrow(/Invalid image 1/)
})

test('detects APNG and WebP animation even when only one frame is advertised', () => {
  const png = imageFixture()
  const control = Buffer.alloc(20)
  control.writeUInt32BE(8)
  control.write('acTL', 4)
  control.writeUInt32BE(1, 8)
  const apng = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)])
  expect(readImageHeaders(apng).animated).toBe(true)
  expect(() => validateImageHeaders(apng, { pixels: 100 })).toThrow(/Animated/)

  const webp = imageFixture('sample.webp')
  const extended = Buffer.alloc(18)
  extended.write('VP8X')
  extended.writeUInt32LE(10, 4)
  extended[8] = 2
  extended[12] = 3
  extended[15] = 2
  const animated = Buffer.concat([webp.subarray(0, 12), extended, webp.subarray(12)])
  animated.writeUInt32LE(animated.length - 8, 4)
  expect(() => validateImageHeaders(animated, { pixels: 100 })).toThrow(/Animated/)
  extended[8] = 0
  const anim = Buffer.alloc(14)
  anim.write('ANIM')
  anim.writeUInt32LE(6, 4)
  const chunkAnimation = Buffer.concat([webp.subarray(0, 12), extended, anim, webp.subarray(12)])
  chunkAnimation.writeUInt32LE(chunkAnimation.length - 8, 4)
  expect(() => validateImageHeaders(chunkAnimation, { pixels: 100 })).toThrow(/Animated/)
})

test('rejects chunk overflows and inconsistent WebP canvas dimensions', () => {
  const png = imageFixture()
  png.writeUInt32BE(0xffffffff, 8)
  expect(() => readImageHeaders(png)).toThrow()
  const webp = imageFixture('sample.webp')
  webp.writeUInt32LE(0xffffffff, 16)
  expect(() => readImageHeaders(webp)).toThrow()
  const extended = Buffer.alloc(18)
  extended.write('VP8X')
  extended.writeUInt32LE(10, 4)
  const mismatch = Buffer.concat([webp.subarray(0, 12), extended, imageFixture('sample.webp').subarray(12)])
  mismatch.writeUInt32LE(mismatch.length - 8, 4)
  expect(() => readImageHeaders(mismatch)).toThrow()
})
