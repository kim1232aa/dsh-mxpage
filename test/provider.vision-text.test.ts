import assert from 'node:assert/strict'
import test from 'node:test'
import type { Config } from '../src/config.ts'
import {
  JSON_SYSTEM,
  NO_VISION,
  resolveCompleteJson,
  type SaveImageFn,
} from '../src/provider/vision-text.ts'

const PNG = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
))

function testConfig(): Config {
  return {
    imageBaseUrl: 'https://api.openai.com/v1',
    imageApiKeyEnv: 'MXPAGE_IMAGE_API_KEY',
    imageModel: 'gpt-image-2',
    defaultLanguage: 'zh-CN',
    defaultHeroCount: 3,
    defaultDetailCount: 6,
    defaultDetailAspectRatio: '3:4',
    timeoutMs: 180_000,
    analyzeTimeoutMs: 120_000,
    maxReferenceImages: 4,
    maxParallelSections: 2,
    generateAsJob: true,
    allowSvgFallback: false,
  }
}

test('llm stream receives type image not image_url when images are provided', async () => {
  const streamCalls: Array<Record<string, unknown>> = []
  const saved: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []
  const saveImage: SaveImageFn = async (input) => {
    saved.push(input)
    return {
      attachmentId: 'att_vision',
      mediaType: 'image/png',
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    }
  }
  const llm = {
    async *stream(options: Record<string, unknown>) {
      streamCalls.push(options)
      yield { type: 'text-delta', text: '{"productName":"cube"}' }
    },
  }
  const completeJson = resolveCompleteJson({ llm, config: testConfig(), saveImage })
  assert.ok(completeJson)
  const result = await completeJson({
    system: JSON_SYSTEM,
    user: 'analyze this product',
    images: [{ bytes: PNG, mediaType: 'image/png', filename: 'product.png' }],
  })
  assert.equal(result.ok, true)
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.mediaType, 'image/png')
  assert.equal(saved[0]?.name, 'product.png')
  assert.equal(streamCalls.length, 1)
  const options = streamCalls[0]!
  assert.equal(options.system, JSON_SYSTEM)
  const messages = options.messages as Array<{ content: Array<{ type: string; attachment?: { attachmentId: string } }> }>
  const blocks = messages[0]?.content ?? []
  assert.ok(blocks.some((block) => block.type === 'text'))
  assert.ok(blocks.some((block) => block.type === 'image'))
  assert.ok(!blocks.some((block) => block.type === 'image_url'))
  assert.equal(blocks.find((block) => block.type === 'image')?.attachment?.attachmentId, 'att_vision')
})

test('llm path returns NO_VISION instead of text-only when saveImage is missing', async () => {
  let streamed = false
  const llm = {
    async *stream() {
      streamed = true
      yield { type: 'text-delta', text: '{"productName":"guess"}' }
    },
  }
  const completeJson = resolveCompleteJson({ llm, config: testConfig() })
  assert.ok(completeJson)
  const result = await completeJson({
    system: JSON_SYSTEM,
    user: 'analyze this product',
    images: [{ bytes: PNG, mediaType: 'image/png' }],
  })
  assert.deepEqual(result, { ok: false, error: NO_VISION })
  assert.equal(streamed, false)
})

test('llm path returns NO_VISION when the route has no image modality', async () => {
  let streamed = false
  const saveImage: SaveImageFn = async (input) => ({
    attachmentId: 'att_vision',
    mediaType: 'image/png',
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
  })
  const llm = {
    listProviders: () => ['openai'],
    listModels: async () => [{ id: 'gpt-4', inputModalities: ['text'] }],
    async *stream() {
      streamed = true
      yield { type: 'text-delta', text: '{"productName":"guess"}' }
    },
  }
  const completeJson = resolveCompleteJson({ llm, config: testConfig(), saveImage })
  assert.ok(completeJson)
  const result = await completeJson({
    system: JSON_SYSTEM,
    user: 'analyze this product',
    images: [{ bytes: PNG, mediaType: 'image/png' }],
  })
  assert.deepEqual(result, { ok: false, error: NO_VISION })
  assert.equal(streamed, false)
})
