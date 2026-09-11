import { readFileSync, statSync } from 'node:fs'
import { redactSecrets } from './redact.ts'

/** Maximum encoded size of one image (20 MiB), matching dsh-attachment-local. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Maximum decoded width or height in pixels. */
export const MAX_IMAGE_EDGE = 8192

function fail(message: string): never {
  throw new Error(redactSecrets(message))
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  )
}

function parsePngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) return null
  }
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null
  }
  return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) }
}

function parseJpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i < bytes.length - 8) {
    if (bytes[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = bytes[i + 1]!
    if (marker === 0xff) {
      i += 1
      continue
    }
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSof) {
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!
      return { width, height }
    }
    // Markers without a length payload: SOI/EOI/RSTn/TEM
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (i + 3 >= bytes.length) return null
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!
    if (length < 2) return null
    i += 2 + length
  }
  return null
}

export function readImageFile(absPath: string): { bytes: Uint8Array; mediaType: string } {
  const size = statSync(absPath).size
  if (size > MAX_IMAGE_BYTES) fail('image exceeds 20MiB')

  const bytes = new Uint8Array(readFileSync(absPath))
  if (bytes.byteLength > MAX_IMAGE_BYTES) fail('image exceeds 20MiB')

  const png = parsePngSize(bytes)
  if (png) {
    if (png.width > MAX_IMAGE_EDGE || png.height > MAX_IMAGE_EDGE) fail('image edge exceeds 8192')
    return { bytes, mediaType: 'image/png' }
  }

  const jpeg = parseJpegSize(bytes)
  if (jpeg) {
    if (jpeg.width > MAX_IMAGE_EDGE || jpeg.height > MAX_IMAGE_EDGE) fail('image edge exceeds 8192')
    return { bytes, mediaType: 'image/jpeg' }
  }

  fail('unsupported image format')
}
