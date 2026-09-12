/**
 * Minimal, dependency-free ZIP writer (STORE + DEFLATE).
 *
 * Added by the DSH port: upstream `lib/services/export-service.ts` streamed the
 * archive with the CJS `archiver` package into
 * `path.join(process.cwd(), 'tmp-export-<projectId>-<ts>.zip')`, read it back
 * with `fsp.readFile`, then deleted it. That needed a dependency AND a temp file
 * next to the host's cwd, which a plugin must never create. This module produces
 * the same archive bytes in memory.
 *
 * Scope (deliberately small — this is not a general zip library):
 *  - single-segment archives only: no ZIP64, no spanning, no encryption, no
 *    data descriptors, no extra fields, no archive comment.
 *  - no explicit directory entries. Folder entries appear implicitly through
 *    `dir/name` paths, which is exactly what `archiver.append(buffer, { name })`
 *    produced upstream, and every extractor (Windows Explorer, `Expand-Archive`,
 *    Info-ZIP `unzip`, Python `zipfile`) creates the folders from them.
 *  - sizes and CRC-32 are written into the local header (bit 3 stays clear)
 *    because the whole entry is in memory before the header is emitted.
 *
 * Format: PKWARE APPNOTE 6.3.x — local file header (0x04034b50), central
 * directory file header (0x02014b50), end of central directory (0x06054b50).
 * General purpose bit 11 (0x0800) is set so names are read as UTF-8, which is
 * what makes the Chinese folder names (`00-头图/`, `01-详情页/`) extract intact.
 */

import { deflateRawSync } from 'node:zlib'

import { normalizeRelPath } from '../ports/storage.ts'

/** One archive member. */
export interface ZipEntry {
  /** Archive path, POSIX style (`dir/file.ext`). Normalized and escape-checked. */
  name: string
  data: Buffer | Uint8Array | string
}

export interface ZipOptions {
  /**
   * Deflate level 0-9. `0` stores every entry. Entries are stored whenever
   * deflate would not make them smaller (already-compressed images), which is
   * what `archiver` also ends up doing for incompressible input.
   */
  level?: number
  /** Timestamp written into every entry's DOS date/time field. Defaults to now. */
  modifiedAt?: Date
}

const SIG_LOCAL_FILE_HEADER = 0x04034b50
const SIG_CENTRAL_FILE_HEADER = 0x02014b50
const SIG_END_OF_CENTRAL_DIR = 0x06054b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** General purpose bit 11: the file name is UTF-8. */
const FLAG_UTF8 = 0x0800

/** "Version needed to extract" 2.0 — the minimum that covers deflate. */
const VERSION_NEEDED = 20
/** "Version made by": 0x00 = MS-DOS/FAT host, 2.0. */
const VERSION_MADE_BY = 0x0014

const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const END_OF_CENTRAL_DIR_SIZE = 22

const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff

/** Reflected CRC-32 (IEEE 802.3) table — polynomial 0xEDB88320. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32 of `data` as an unsigned 32-bit integer. */
export function crc32(data: Uint8Array): number {
  let crc = -1
  for (let index = 0; index < data.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[index]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

function toBuffer(data: Buffer | Uint8Array | string): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
}

/** MS-DOS date/time pair (year-1980, 2-second resolution). */
function toDosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear()
  const dosYear = year < 1980 ? 0 : Math.min(year - 1980, 127)
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: (dosYear << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** Deflates when that is actually smaller, otherwise stores. */
function compress(content: Buffer, level: number): { method: number; body: Buffer } {
  if (level <= 0) return { method: METHOD_STORE, body: content }

  const deflated = deflateRawSync(content, { level })
  return deflated.length < content.length
    ? { method: METHOD_DEFLATE, body: deflated }
    : { method: METHOD_STORE, body: content }
}

function assertUint32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`zip: ${label} does not fit the 32-bit ZIP format (ZIP64 unsupported)`)
  }
  return value
}

/**
 * Builds a complete ZIP archive in memory.
 *
 * @example
 * const buffer = createZip([
 *   { name: '00-头图/mx_1700000000000_01.jpg', data: jpegBuffer },
 *   { name: 'export-manifest.json', data: JSON.stringify(manifest, null, 2) },
 * ], { level: 9 })
 */
export function createZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Buffer {
  const level = options.level ?? 9
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new Error(`zip: deflate level must be an integer 0-9, received ${level}`)
  }
  if (entries.length > UINT16_MAX) {
    throw new Error(`zip: ${entries.length} entries exceed the 16-bit ZIP limit (ZIP64 unsupported)`)
  }

  const { time: dosTime, date: dosDate } = toDosDateTime(options.modifiedAt ?? new Date())

  const parts: Buffer[] = []
  const centralDirectory: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = normalizeRelPath(entry.name)
    const nameBytes = Buffer.from(name, 'utf8')
    if (nameBytes.length > UINT16_MAX) {
      throw new Error(`zip: entry name too long (${nameBytes.length} bytes): ${name}`)
    }

    const content = toBuffer(entry.data)
    const { method, body } = compress(content, level)

    const crc = crc32(content)
    assertUint32(body.length, `compressed size of ${name}`)
    assertUint32(content.length, `uncompressed size of ${name}`)
    assertUint32(offset, `local header offset of ${name}`)

    const localHeader = Buffer.alloc(LOCAL_HEADER_SIZE)
    localHeader.writeUInt32LE(SIG_LOCAL_FILE_HEADER, 0)
    localHeader.writeUInt16LE(VERSION_NEEDED, 4)
    localHeader.writeUInt16LE(FLAG_UTF8, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(body.length, 18)
    localHeader.writeUInt32LE(content.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28)

    const centralHeader = Buffer.alloc(CENTRAL_HEADER_SIZE)
    centralHeader.writeUInt32LE(SIG_CENTRAL_FILE_HEADER, 0)
    centralHeader.writeUInt16LE(VERSION_MADE_BY, 4)
    centralHeader.writeUInt16LE(VERSION_NEEDED, 6)
    centralHeader.writeUInt16LE(FLAG_UTF8, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(body.length, 20)
    centralHeader.writeUInt32LE(content.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    parts.push(localHeader, nameBytes, body)
    centralDirectory.push(centralHeader, nameBytes)

    offset += LOCAL_HEADER_SIZE + nameBytes.length + body.length
  }

  const centralDirectoryBuffer = Buffer.concat(centralDirectory)
  assertUint32(offset, 'start offset of the central directory')
  assertUint32(centralDirectoryBuffer.length, 'size of the central directory')

  const endOfCentralDirectory = Buffer.alloc(END_OF_CENTRAL_DIR_SIZE)
  endOfCentralDirectory.writeUInt32LE(SIG_END_OF_CENTRAL_DIR, 0)
  endOfCentralDirectory.writeUInt16LE(0, 4)
  endOfCentralDirectory.writeUInt16LE(0, 6)
  endOfCentralDirectory.writeUInt16LE(entries.length, 8)
  endOfCentralDirectory.writeUInt16LE(entries.length, 10)
  endOfCentralDirectory.writeUInt32LE(centralDirectoryBuffer.length, 12)
  endOfCentralDirectory.writeUInt32LE(offset, 16)
  endOfCentralDirectory.writeUInt16LE(0, 20)

  return Buffer.concat([...parts, centralDirectoryBuffer, endOfCentralDirectory])
}
