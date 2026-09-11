import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Config } from '../config.ts'
import { redactSecrets } from '../util/redact.ts'

export const JSON_SYSTEM = '只输出一个 JSON 对象'
export const NO_VISION = '当前模型不支持视觉，无法分析商品图'

export interface VisionImage {
  bytes: Uint8Array
  mediaType: string
  filename?: string
}

export interface CompleteJsonInput {
  system: string
  user: string
  images?: VisionImage[]
  signal?: AbortSignal
  model?: string
}

export type CompleteJsonResult =
  | { ok: true; text: string; modelUsed: string }
  | { ok: false; error: string }

export type CompleteJson = (input: CompleteJsonInput) => Promise<CompleteJsonResult>

export type JsonParseFn<T> = (value: unknown) => T

export interface SavedImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

export type SaveImageFn = (input: {
  data: Uint8Array
  mediaType: string
  name?: string
}) => Promise<SavedImageRef>

export function extractJsonBlock(raw: string): string {
  const direct = raw.trim()
  if (direct.startsWith('{') || direct.startsWith('[')) return direct
  const fenced = direct.match(/```json([\s\S]*?)```/i) ?? direct.match(/```([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const first = direct.indexOf('{')
  const last = direct.lastIndexOf('}')
  if (first >= 0 && last > first) return direct.slice(first, last + 1)
  return direct
}

function failResult(error: string): CompleteJsonResult {
  return { ok: false, error: redactSecrets(error) }
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return Boolean(err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError')
}

export function llmLooksUsable(llm: unknown): boolean {
  if (!llm || typeof llm !== 'object') return false
  return typeof (llm as { stream?: unknown }).stream === 'function'
}

async function llmHasVision(llm: object, signal?: AbortSignal): Promise<boolean | undefined> {
  const rec = llm as {
    listProviders?: () => unknown
    listModels?: (provider: string) => Promise<unknown>
  }
  if (typeof rec.listProviders !== 'function' || typeof rec.listModels !== 'function') return undefined
  try {
    const providers = rec.listProviders()
    const list = Array.isArray(providers) ? providers : []
    for (const provider of list) {
      const id = typeof provider === 'string'
        ? provider
        : provider && typeof provider === 'object' && 'id' in provider
          ? String((provider as { id: unknown }).id)
          : ''
      if (!id) continue
      const models = await rec.listModels(id)
      if (!Array.isArray(models)) continue
      for (const model of models) {
        const modalities = model && typeof model === 'object'
          ? (model as { inputModalities?: unknown; input?: unknown }).inputModalities
            ?? (model as { input?: unknown }).input
          : undefined
        if (Array.isArray(modalities) && modalities.includes('image')) return true
      }
    }
    if (signal?.aborted) return undefined
    return list.length > 0 ? false : undefined
  } catch {
    return undefined
  }
}

function dataUrl(image: VisionImage): string {
  return `data:${image.mediaType || 'image/png'};base64,${Buffer.from(image.bytes).toString('base64')}`
}

function asImageMediaType(value: string): string {
  if (value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif' || value === 'image/png') {
    return value
  }
  return 'image/png'
}

async function collectStreamText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = ''
  let blockText = ''
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    const rec = chunk as Record<string, unknown>
    if (rec.type === 'text-delta' && typeof rec.text === 'string') text += rec.text
    if (rec.type === 'block-end' && rec.block && typeof rec.block === 'object') {
      const block = rec.block as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string') blockText += block.text
    }
    if (rec.type === 'finish' && rec.reason && typeof rec.reason === 'object') {
      const reason = rec.reason as { kind?: string; failure?: { message?: string } }
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        throw new Error(reason.failure?.message || reason.kind)
      }
    }
  }
  return text || blockText
}

function firstProvider(llm: object): string | undefined {
  const rec = llm as { listProviders?: () => unknown }
  if (typeof rec.listProviders !== 'function') return undefined
  try {
    const providers = rec.listProviders()
    if (!Array.isArray(providers) || providers.length === 0) return undefined
    const first = providers[0]
    if (typeof first === 'string') return first
    if (first && typeof first === 'object' && 'id' in first) return String((first as { id: unknown }).id)
  } catch {
    return undefined
  }
  return undefined
}

function createLlmCompleteJson(llm: object, saveImage?: SaveImageFn): CompleteJson {
  const rec = llm as {
    stream: (options: Record<string, unknown>) => AsyncIterable<unknown>
    listModels?: (provider: string) => Promise<unknown>
  }
  return async (input) => {
    if (input.signal?.aborted) throw new Error('已取消')
    const images = input.images ?? []
    if (images.length > 0) {
      const vision = await llmHasVision(llm, input.signal)
      if (vision === false) return failResult(NO_VISION)
      if (!saveImage) return failResult(NO_VISION)
    }
    const provider = firstProvider(llm) ?? 'default'
    let model = input.model
    if (!model && typeof rec.listModels === 'function') {
      try {
        const models = await rec.listModels(provider)
        if (Array.isArray(models) && models.length > 0) {
          const withImage = models.find((item) => {
            const modalities = item && typeof item === 'object'
              ? (item as { inputModalities?: unknown }).inputModalities
              : undefined
            return Array.isArray(modalities) && modalities.includes('image')
          })
          const picked = (images.length ? withImage : undefined) ?? models[0]
          if (picked && typeof picked === 'object' && 'id' in picked) model = String((picked as { id: unknown }).id)
        }
      } catch {
        // fall through
      }
    }
    model = model ?? 'default'
    const content: ContentBlock[] = [
      { type: 'text', text: input.user },
    ]
    if (images.length > 0 && saveImage) {
      try {
        for (const image of images) {
          const ref = await saveImage({
            data: image.bytes,
            mediaType: asImageMediaType(image.mediaType),
            name: image.filename,
          })
          content.push({ type: 'image', attachment: ref } as ContentBlock)
        }
      } catch (err) {
        if (isAbort(err, input.signal)) throw new Error('已取消')
        return failResult(err instanceof Error ? err.message : String(err))
      }
    }
    try {
      const text = await collectStreamText(rec.stream({
        provider,
        model,
        system: input.system || JSON_SYSTEM,
        messages: [
          createUserMessage({
            content,
            source: { kind: 'plugin', plugin: 'mxpage' },
          }),
        ],
        signal: input.signal,
      }))
      if (input.signal?.aborted) throw new Error('已取消')
      if (!text.trim()) return failResult(NO_VISION)
      return { ok: true, text, modelUsed: model }
    } catch (err) {
      if (isAbort(err, input.signal)) throw new Error('已取消')
      return failResult(err instanceof Error ? err.message : String(err))
    }
  }
}

function createHttpCompleteJson(opts: { baseUrl: string; apiKey: string; model: string }): CompleteJson {
  return async (input) => {
    if (input.signal?.aborted) throw new Error('已取消')
    const model = input.model ?? opts.model
    const userContent: unknown = (input.images?.length ?? 0) > 0
      ? [
          { type: 'text', text: input.user },
          ...(input.images ?? []).map((image) => ({
            type: 'image_url',
            image_url: { url: dataUrl(image) },
          })),
        ]
      : input.user
    const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: input.system || JSON_SYSTEM },
            { role: 'user', content: userContent },
          ],
        }),
        signal: input.signal,
      })
    } catch (err) {
      if (isAbort(err, input.signal)) throw new Error('已取消')
      return failResult(err instanceof Error ? err.message : String(err))
    }
    const body = await res.text().catch(() => '')
    if (!res.ok) {
      return failResult(`文本模型请求失败 (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    let payload: { choices?: Array<{ message?: { content?: unknown } }> }
    try {
      payload = JSON.parse(body) as typeof payload
    } catch {
      return failResult('文本模型响应无效')
    }
    const content = payload.choices?.[0]?.message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('')
        : ''
    if (!text.trim()) return failResult('文本模型返回空数据')
    return { ok: true, text, modelUsed: model }
  }
}

export function resolveCompleteJson(opts: {
  completeJson?: CompleteJson
  llm?: unknown
  config: Config
  saveImage?: SaveImageFn
}): CompleteJson | undefined {
  if (opts.completeJson) return opts.completeJson

  const http = (() => {
    const baseUrl = opts.config.textBaseUrl?.trim()
    const model = opts.config.textModel?.trim()
    const envName = opts.config.textApiKeyEnv?.trim()
    if (!baseUrl || !model || !envName) return undefined
    const apiKey = process.env[envName]
    if (!apiKey) return undefined
    return createHttpCompleteJson({ baseUrl, apiKey, model })
  })()

  if (llmLooksUsable(opts.llm)) {
    const llmCaller = createLlmCompleteJson(opts.llm as object, opts.saveImage)
    if (!http) return llmCaller
    return async (input) => {
      if (input.images && input.images.length > 0) {
        const vision = await llmHasVision(opts.llm as object, input.signal)
        if (vision === false) return http(input)
      }
      const result = await llmCaller(input)
      if (!result.ok && http) return http(input)
      return result
    }
  }

  return http
}

export async function completeValidatedJson<T>(
  completeJson: CompleteJson,
  opts: {
    system?: string
    user: string
    images?: VisionImage[]
    parse: JsonParseFn<T>
    repairUser?: (raw: string) => string
    signal?: AbortSignal
    model?: string
  },
): Promise<{ ok: true; value: T; modelUsed: string } | { ok: false; error: string }> {
  const system = opts.system ?? JSON_SYSTEM

  const tryOnce = async (user: string): Promise<CompleteJsonResult> => {
    return completeJson({
      system,
      user,
      images: opts.images,
      signal: opts.signal,
      model: opts.model,
    })
  }

  const parseText = (text: string): { ok: true; value: T } | { ok: false; error: string } => {
    try {
      const json = JSON.parse(extractJsonBlock(text)) as unknown
      return { ok: true, value: opts.parse(json) }
    } catch (err) {
      return { ok: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) }
    }
  }

  const first = await tryOnce(opts.user)
  if (!first.ok) return first
  const parsed = parseText(first.text)
  if (parsed.ok) return { ok: true, value: parsed.value, modelUsed: first.modelUsed }

  const repairUser = opts.repairUser?.(first.text) ?? `只输出一个 JSON 对象。Repair the following into one JSON object:\n${first.text}`
  const second = await tryOnce(repairUser)
  if (!second.ok) return second
  const repaired = parseText(second.text)
  if (repaired.ok) return { ok: true, value: repaired.value, modelUsed: second.modelUsed }
  return { ok: false, error: repaired.error }
}
