export interface RenderImageRef {
  attachmentId: string
  mediaType?: string
  bytes?: number
  width?: number
  height?: number
  name?: string
}

export type RenderBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  } }

function asImage(input: unknown): RenderBlock | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as Record<string, unknown>
  const attachmentId = typeof rec.attachmentId === 'string' ? rec.attachmentId : ''
  if (!attachmentId) return undefined
  const mediaType = typeof rec.mediaType === 'string' && rec.mediaType.startsWith('image/')
    ? rec.mediaType
    : 'image/png'
  const attachment: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  } = {
    attachmentId,
    mediaType,
    bytes: typeof rec.bytes === 'number' ? rec.bytes : 0,
    width: typeof rec.width === 'number' ? rec.width : 0,
    height: typeof rec.height === 'number' ? rec.height : 0,
  }
  if (typeof rec.name === 'string' && rec.name) attachment.name = rec.name
  return { type: 'image', attachment }
}

export function renderJsonAndImages(_args: unknown, value: unknown): RenderBlock[] {
  const blocks: RenderBlock[] = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  if (!value || typeof value !== 'object') return blocks
  const rec = value as Record<string, unknown>
  const seen = new Set<string>()
  const push = (raw: unknown) => {
    const block = asImage(raw)
    if (!block || seen.has(block.attachment.attachmentId)) return
    seen.add(block.attachment.attachmentId)
    blocks.push(block)
  }
  if (Array.isArray(rec.outputs)) {
    for (const item of rec.outputs) push(item)
  }
  push(rec)
  return blocks
}

export const textRender = (_args: unknown, value: unknown): RenderBlock[] => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]
