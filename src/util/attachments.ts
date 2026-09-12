import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertInside } from './paths.ts'
import { redactSecrets } from './redact.ts'

export interface AttachmentReader {
  readImage?(
    ref: { attachmentId: string },
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; ref?: { mediaType?: string; name?: string } }>
  imageHostPath?(ref: { attachmentId: string }): string | undefined
}

function sniffExt(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return '.png'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg'
  return '.png'
}

export function assertAttachmentId(id: string): string {
  const value = id.trim()
  if (!value || value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new Error(redactSecrets('invalid attachment_id'))
  }
  return value
}

export async function materializeAttachment(
  storeRoot: string,
  attachmentId: string,
  attachments?: AttachmentReader,
  signal?: AbortSignal,
): Promise<string> {
  const id = assertAttachmentId(attachmentId)
  if (!attachments) throw new Error('无法读取附件')
  let bytes: Uint8Array | undefined
  const hostPath = attachments.imageHostPath?.({ attachmentId: id })
  if (hostPath && existsSync(hostPath)) {
    bytes = new Uint8Array(readFileSync(hostPath))
  } else if (attachments.readImage) {
    const stored = await attachments.readImage({ attachmentId: id }, signal)
    bytes = stored.data
  }
  if (!bytes || bytes.byteLength === 0) throw new Error('无法读取附件')
  const incoming = assertInside(storeRoot, join(storeRoot, 'incoming'))
  mkdirSync(incoming, { recursive: true })
  const dest = assertInside(storeRoot, join(incoming, `att_${randomUUID()}${sniffExt(bytes)}`))
  writeFileSync(dest, Buffer.from(bytes))
  return dest
}
