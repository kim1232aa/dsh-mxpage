import { redactSecrets } from '../util/redact.ts'

export type ImageSize = '1024x1024' | '1024x1536'

export interface ImageBlob {
  bytes: Uint8Array
  filename: string
  mediaType: string
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface ImagesClient {
  generate(input: {
    prompt: string
    size: ImageSize
    model: string
    references: ImageBlob[]
    signal: AbortSignal
  }): Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }>
  edit(input: {
    prompt: string
    size: ImageSize
    model: string
    image: ImageBlob
    references: ImageBlob[]
    signal: AbortSignal
  }): Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }>
}

export function isQuotaBody(body: string): boolean {
  return /insufficient_user_quota|预扣费额度失败|out of credits|额度失败|用户额度不足|额度不足|余额不足|remaining quota/i.test(body)
}

export function mapImageError(status: number, body: string): { ok: false; error: string } {
  if (status === 401) {
    return { ok: false, error: '图像 API 密钥无效或未配置' }
  }
  if (status === 429 || isQuotaBody(body)) {
    return { ok: false, error: '额度或速率限制' }
  }
  if (status === 400 && /model/i.test(body) && !/does not support image generation/i.test(body)) {
    return { ok: false, error: '模型不支持' }
  }
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  const detail = snippet ? `: ${snippet}` : ''
  return { ok: false, error: redactSecrets(`图像 API 请求失败 (${status})${detail}`) }
}

export function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /额度或速率限制/.test(message)
}

function throwRedacted(message: string): never {
  throw new Error(redactSecrets(message))
}

function throwMapped(status: number, body: string): never {
  throwRedacted(mapImageError(status, body).error)
}

function throwCancelled(): never {
  throw new Error('已取消')
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return Boolean(err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError')
}

function endpoint(baseUrl: string, path: '/images/generations' | '/images/edits' | '/chat/completions'): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function toBlob(image: ImageBlob): Blob {
  const copy = new Uint8Array(image.bytes.byteLength)
  copy.set(image.bytes)
  return new Blob([copy], { type: image.mediaType || 'application/octet-stream' })
}

type ImageFormField = 'image' | 'images' | 'image[]'

function appendImage(form: FormData, image: ImageBlob, field: ImageFormField = 'image'): void {
  form.append(field, toBlob(image), image.filename)
}

function asImage(bytes: Uint8Array): { bytes: Uint8Array; mediaType: ImageMediaType } {
  if (bytes.byteLength < 3) throwRedacted('图像 API 返回空数据')
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, mediaType: 'image/jpeg' }
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { bytes, mediaType: 'image/webp' }
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { bytes, mediaType: 'image/png' }
  }
  throwRedacted('图像 API 返回空数据')
}

export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'
  return 'image/png'
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const rec = part as Record<string, unknown>
    if (typeof rec.text === 'string') return rec.text
    if (typeof rec.image_url === 'string') return rec.image_url
    if (rec.image_url && typeof rec.image_url === 'object' && typeof (rec.image_url as { url?: unknown }).url === 'string') {
      return String((rec.image_url as { url: string }).url)
    }
    return ''
  }).join('\n')
}

export function extractImageB64(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const rec = payload as Record<string, unknown>
  const data = rec.data
  if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
    const first = data[0] as Record<string, unknown>
    if (typeof first.b64_json === 'string' && first.b64_json.trim()) return first.b64_json.trim()
  }
  const choices = rec.choices
  const content = Array.isArray(choices) && choices[0] && typeof choices[0] === 'object'
    ? (choices[0] as { message?: { content?: unknown } }).message?.content
    : undefined
  const text = flattenContent(content)
  const match = text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\n\r]+)/i)
  if (match?.[1]) return match[1].replace(/\s+/g, '')
  return undefined
}

function extractImageUrl(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const rec = payload as Record<string, unknown>
  const data = rec.data
  if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
    const url = (data[0] as { url?: unknown }).url
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
  }
  return undefined
}

export function shouldFallbackToChat(status: number, body: string): boolean {
  if (status === 401 || status === 429) return false
  if (isQuotaBody(body)) return false
  if (status === 400 && /model/i.test(body) && !/does not support image generation/i.test(body)) return false
  return status >= 400
}

function dataUrl(image: ImageBlob): string {
  const type = image.mediaType || 'image/png'
  return `data:${type};base64,${Buffer.from(image.bytes).toString('base64')}`
}

function editForm(
  prompt: string,
  model: string,
  size: ImageSize,
  images: ImageBlob[],
  field: ImageFormField = 'image',
): FormData {
  const form = new FormData()
  form.append('prompt', prompt)
  form.append('model', model)
  form.append('size', size)
  for (const image of images) appendImage(form, image, field)
  return form
}

function editJsonBody(
  prompt: string,
  model: string,
  size: ImageSize,
  images: ImageBlob[],
): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt, model, size }
  if (images.length <= 1) {
    const image = images[0]
    if (image) body.image = { type: 'image_url', url: dataUrl(image) }
    return body
  }
  body.images = images.map((image) => ({ type: 'image_url', url: dataUrl(image) }))
  return body
}

export function createImagesClient(opts: {
  baseUrl: string
  apiKey: string
  fetch?: typeof fetch
}): ImagesClient {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis)

  async function parsePayload(payload: unknown, signal: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }> {
    const b64 = extractImageB64(payload)
    if (b64) return asImage(new Uint8Array(Buffer.from(b64, 'base64')))
    const url = extractImageUrl(payload)
    if (!url) throwRedacted('图像 API 返回空数据')
    if (signal.aborted) throwCancelled()
    let res: Response
    try {
      res = await fetchFn(url, { signal })
    } catch (err) {
      if (isAbort(err, signal)) throwCancelled()
      throwRedacted(err instanceof Error ? err.message : String(err))
    }
    if (!res.ok) throwRedacted(`图像下载失败 (${res.status})`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength < 32) throwRedacted('图像 API 返回空数据')
    return asImage(buf)
  }

  async function parseRaw(raw: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }> {
    const fromText = raw.match(/data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\n\r]+)/i)
    const tryJson = (text: string): unknown | undefined => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        const first = text.indexOf('{')
        const last = text.lastIndexOf('}')
        if (first < 0 || last <= first) return undefined
        try {
          return JSON.parse(text.slice(first, last + 1)) as unknown
        } catch {
          return undefined
        }
      }
    }
    const payload = tryJson(raw)
    if (payload !== undefined) {
      try {
        return await parsePayload(payload, signal)
      } catch (err) {
        if (isAbort(err, signal)) throwCancelled()
      }
    }
    if (fromText?.[1]) return asImage(new Uint8Array(Buffer.from(fromText[1].replace(/\s+/g, ''), 'base64')))
    throwRedacted('图像 API 返回空数据')
  }

  async function postJson(path: '/images/generations' | '/images/edits' | '/chat/completions', body: unknown, signal: AbortSignal): Promise<Response> {
    return fetchFn(endpoint(opts.baseUrl, path), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
  }

  async function requestChat(
    prompt: string,
    model: string,
    size: ImageSize,
    images: ImageBlob[],
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }> {
    if (signal.aborted) throwCancelled()
    const parts: unknown[] = [{
      type: 'text',
      text: [
        prompt,
        `Output a single product image only. Approximate size ${size}. No watermark.`,
        images.length > 0 ? 'Keep the product identity from the attached reference photos. The first image is the main product.' : '',
      ].filter(Boolean).join('\n'),
    }]
    for (const image of images.slice(0, 4)) {
      parts.push({
        type: 'image_url',
        image_url: { url: dataUrl(image) },
      })
    }
    let res: Response
    try {
      res = await postJson('/chat/completions', {
        model,
        messages: [{ role: 'user', content: parts }],
      }, signal)
    } catch (err) {
      if (isAbort(err, signal)) throwCancelled()
      throwRedacted(err instanceof Error ? err.message : String(err))
    }
    const raw = await res.text().catch(() => '')
    if (!res.ok) throwMapped(res.status, raw)
    return parseRaw(raw, signal)
  }

  async function request(
    path: '/images/generations' | '/images/edits',
    init: { headers?: Record<string, string>; body: string | FormData },
    signal: AbortSignal,
    fallback: () => Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }>,
  ): Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }> {
    if (signal.aborted) throwCancelled()

    let res: Response
    try {
      res = await fetchFn(endpoint(opts.baseUrl, path), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          ...init.headers,
        },
        body: init.body,
        signal,
      })
    } catch (err) {
      if (isAbort(err, signal)) throwCancelled()
      throwRedacted(err instanceof Error ? err.message : String(err))
    }

    const raw = await res.text().catch(() => '')
    if (!res.ok) {
      if (shouldFallbackToChat(res.status, raw)) return fallback()
      throwMapped(res.status, raw)
    }
    try {
      return await parseRaw(raw, signal)
    } catch (err) {
      if (isAbort(err, signal)) throwCancelled()
      return fallback()
    }
  }

  return {
    generate(input) {
      const chat = () => requestChat(input.prompt, input.model, input.size, input.references.slice(0, 1), input.signal)
      const mp = (
        images: ImageBlob[],
        field: ImageFormField,
        next: () => Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }>,
      ) => request(
        '/images/edits',
        { body: editForm(input.prompt, input.model, input.size, images, field) },
        input.signal,
        next,
      )
      const js = (
        images: ImageBlob[],
        next: () => Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }>,
      ) => request(
        '/images/edits',
        {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editJsonBody(input.prompt, input.model, input.size, images)),
        },
        input.signal,
        next,
      )
      // grok-imagine accepts 2+ refs as JSON `images` or multipart `images` (plural).
      // Repeated multipart `image` / `image[]` is upstream 400 on xAI.
      if (input.references.length > 1) {
        return js(input.references, () =>
          mp(input.references, 'images', () =>
            mp(input.references, 'image[]', () =>
              mp(input.references.slice(0, 1), 'image', chat))))
      }
      if (input.references.length === 1) {
        return mp(input.references, 'image', chat)
      }
      return request(
        '/images/generations',
        {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: input.model,
            prompt: input.prompt,
            size: input.size,
          }),
        },
        input.signal,
        chat,
      )
    },
    edit(input) {
      const images = [input.image, ...input.references]
      const chat = () => requestChat(input.prompt, input.model, input.size, images.slice(0, 1), input.signal)
      const mp = (
        imgs: ImageBlob[],
        field: ImageFormField,
        next: () => Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }>,
      ) => request(
        '/images/edits',
        { body: editForm(input.prompt, input.model, input.size, imgs, field) },
        input.signal,
        next,
      )
      const js = (
        imgs: ImageBlob[],
        next: () => Promise<{ bytes: Uint8Array; mediaType: ImageMediaType }>,
      ) => request(
        '/images/edits',
        {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editJsonBody(input.prompt, input.model, input.size, imgs)),
        },
        input.signal,
        next,
      )
      if (images.length > 1) {
        return js(images, () =>
          mp(images, 'images', () =>
            mp(images, 'image[]', () =>
              mp([input.image], 'image', chat))))
      }
      return mp(images, 'image', chat)
    },
  }
}

export function withQuotaFallback(primary: ImagesClient, fallback: ImagesClient): ImagesClient {
  async function retry<T>(run: () => Promise<T>, backup: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (isQuotaError(err)) return backup()
      throw err
    }
  }
  return {
    generate(input) {
      return retry(() => primary.generate(input), () => fallback.generate(input))
    },
    edit(input) {
      return retry(() => primary.edit(input), () => fallback.edit(input))
    },
  }
}

export function imagesClientFromEnv(config: {
  imageBaseUrl: string
  imageApiKeyEnv: string
}): ImagesClient | undefined {
  const apiKey = process.env[config.imageApiKeyEnv]
  if (!apiKey) return undefined
  const primary = createImagesClient({ baseUrl: config.imageBaseUrl, apiKey })
  const fallbackUrl = process.env.MXPAGE_IMAGE_FALLBACK_BASE_URL?.trim()
  const fallbackKey = process.env.MXPAGE_IMAGE_FALLBACK_API_KEY?.trim()
  if (!fallbackUrl || !fallbackKey) return primary
  const norm = (url: string) => url.replace(/\/+$/, '')
  if (norm(fallbackUrl) === norm(config.imageBaseUrl)) return primary
  return withQuotaFallback(primary, createImagesClient({ baseUrl: fallbackUrl, apiKey: fallbackKey }))
}
