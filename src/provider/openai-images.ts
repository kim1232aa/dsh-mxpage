import { redactSecrets } from '../util/redact.ts'

export type ImageSize = '1024x1024' | '1024x1536'

export interface ImageBlob {
  bytes: Uint8Array
  filename: string
  mediaType: string
}

export interface ImagesClient {
  generate(input: {
    prompt: string
    size: ImageSize
    model: string
    references: ImageBlob[]
    signal: AbortSignal
  }): Promise<{ bytes: Uint8Array; mediaType: 'image/png' }>
  edit(input: {
    prompt: string
    size: ImageSize
    model: string
    image: ImageBlob
    references: ImageBlob[]
    signal: AbortSignal
  }): Promise<{ bytes: Uint8Array; mediaType: 'image/png' }>
}

export function mapImageError(status: number, body: string): { ok: false; error: string } {
  if (status === 401) {
    return { ok: false, error: '图像 API 密钥无效或未配置' }
  }
  if (status === 429) {
    return { ok: false, error: '额度或速率限制' }
  }
  if (status === 400 && /model/i.test(body)) {
    return { ok: false, error: '模型不支持' }
  }
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  const detail = snippet ? `: ${snippet}` : ''
  return { ok: false, error: redactSecrets(`图像 API 请求失败 (${status})${detail}`) }
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

function endpoint(baseUrl: string, path: '/images/generations' | '/images/edits'): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function toBlob(image: ImageBlob): Blob {
  const copy = new Uint8Array(image.bytes.byteLength)
  copy.set(image.bytes)
  return new Blob([copy], { type: image.mediaType || 'application/octet-stream' })
}

function appendImage(form: FormData, image: ImageBlob): void {
  form.append('image', toBlob(image), image.filename)
}

function parsePngResult(payload: unknown): { bytes: Uint8Array; mediaType: 'image/png' } {
  const b64 = (payload as { data?: Array<{ b64_json?: string }> })?.data?.[0]?.b64_json
  if (!b64) throwRedacted('图像 API 返回空数据')
  return { bytes: new Uint8Array(Buffer.from(b64, 'base64')), mediaType: 'image/png' }
}

function editForm(
  prompt: string,
  model: string,
  size: ImageSize,
  images: ImageBlob[],
): FormData {
  const form = new FormData()
  form.append('prompt', prompt)
  form.append('model', model)
  form.append('size', size)
  for (const image of images) appendImage(form, image)
  return form
}

export function createImagesClient(opts: {
  baseUrl: string
  apiKey: string
  fetch?: typeof fetch
}): ImagesClient {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis)

  async function request(
    path: '/images/generations' | '/images/edits',
    init: { headers?: Record<string, string>; body: string | FormData },
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mediaType: 'image/png' }> {
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

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throwMapped(res.status, body)
    }

    let payload: unknown
    try {
      payload = await res.json()
    } catch (err) {
      if (isAbort(err, signal)) throwCancelled()
      throwRedacted(err instanceof Error ? err.message : '图像 API 响应无效')
    }
    return parsePngResult(payload)
  }

  return {
    generate(input) {
      if (input.references.length > 0) {
        return request(
          '/images/edits',
          {
            body: editForm(input.prompt, input.model, input.size, input.references),
          },
          input.signal,
        )
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
      )
    },
    edit(input) {
      return request(
        '/images/edits',
        {
          body: editForm(input.prompt, input.model, input.size, [input.image, ...input.references]),
        },
        input.signal,
      )
    },
  }
}
