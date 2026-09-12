import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createImagesClient, imagesClientFromEnv, mapImageError, sniffImageMediaType, withQuotaFallback } from '../src/provider/openai-images.ts'
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, readImageFile } from '../src/util/images.ts'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

const PNG_REF = {
  bytes: new Uint8Array(PNG),
  filename: 'main.png',
  mediaType: 'image/png',
}

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12)
  buf.writeUInt32BE(width >>> 0, 16)
  buf.writeUInt32BE(height >>> 0, 20)
  buf[24] = 8
  buf[25] = 2
  return buf
}

function jpegSof(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0,
    0x00, 0x0b,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01,
    0xff, 0xd9,
  ])
}

function parseMultipartFieldNames(buf: Buffer, contentType: string): string[] {
  if (!/multipart\/form-data/i.test(contentType)) return []
  const names: string[] = []
  const re = /;\s*name="([^"]+)"/g
  const text = buf.toString('latin1')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) names.push(m[1]!)
  return names
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function sendPng(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))
}

async function listen(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  t.after(() => server.close())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no port')
  return { server, baseUrl: `http://127.0.0.1:${addr.port}/v1` }
}

function client(baseUrl: string) {
  return createImagesClient({ baseUrl, apiKey: 'testdata' })
}

test('generate with a reference posts multipart /images/edits', async (t) => {
  let url = ''
  let authorization: string | undefined
  let contentType = ''
  let fieldNames: string[] = []

  const { baseUrl } = await listen(t, async (req, res) => {
    url = req.url ?? ''
    authorization = req.headers.authorization
    contentType = String(req.headers['content-type'] ?? '')
    const raw = await readBody(req)
    fieldNames = parseMultipartFieldNames(raw, contentType)
    sendPng(res)
  })

  const result = await client(baseUrl).generate({
    prompt: 'a product photo',
    size: '1024x1024',
    model: 'gpt-image-2',
    references: [PNG_REF],
    signal: new AbortController().signal,
  })

  assert.ok(url.endsWith('/images/edits'), url)
  assert.equal(authorization, 'Bearer testdata')
  assert.match(contentType, /multipart\/form-data/i)
  assert.ok(fieldNames.includes('image'), `fields=${fieldNames.join(',')}`)
  assert.ok(fieldNames.includes('prompt'))
  assert.ok(fieldNames.includes('model'))
  assert.ok(fieldNames.includes('size'))
  assert.equal(result.mediaType, 'image/png')
  assert.ok(Buffer.from(result.bytes).equals(PNG))
})

test('generate without references posts JSON /images/generations', async (t) => {
  let url = ''
  let authorization: string | undefined
  let contentType = ''
  let body = ''

  const { baseUrl } = await listen(t, async (req, res) => {
    url = req.url ?? ''
    authorization = req.headers.authorization
    contentType = String(req.headers['content-type'] ?? '')
    body = (await readBody(req)).toString('utf8')
    sendPng(res)
  })

  await client(baseUrl).generate({
    prompt: 'hello',
    size: '1024x1536',
    model: 'gpt-image-2',
    references: [],
    signal: new AbortController().signal,
  })

  assert.ok(url.endsWith('/images/generations'), url)
  assert.equal(authorization, 'Bearer testdata')
  assert.match(contentType, /application\/json/)
  assert.deepEqual(JSON.parse(body), {
    model: 'gpt-image-2',
    prompt: 'hello',
    size: '1024x1536',
  })
})

test('edit always posts multipart /images/edits with image field', async (t) => {
  let url = ''
  let fieldNames: string[] = []

  const { baseUrl } = await listen(t, async (req, res) => {
    url = req.url ?? ''
    const contentType = String(req.headers['content-type'] ?? '')
    fieldNames = parseMultipartFieldNames(await readBody(req), contentType)
    sendPng(res)
  })

  await client(baseUrl).edit({
    prompt: 'repaint the background',
    size: '1024x1024',
    model: 'gpt-image-2',
    image: { bytes: new Uint8Array(PNG), filename: 'current.png', mediaType: 'image/png' },
    references: [PNG_REF],
    signal: new AbortController().signal,
  })

  assert.ok(url.endsWith('/images/edits'), url)
  assert.ok(fieldNames.includes('image'), `fields=${fieldNames.join(',')}`)
  assert.ok(fieldNames.includes('prompt'))
})

test('aborting the signal rejects with 已取消', { timeout: 8000 }, async (t) => {
  const { baseUrl } = await listen(t, () => {
    /* hang until the client aborts */
  })

  const ac = new AbortController()
  const pending = client(baseUrl).generate({
    prompt: 'x',
    size: '1024x1024',
    model: 'gpt-image-2',
    references: [],
    signal: ac.signal,
  })
  ac.abort()
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof Error)
    assert.match(err.message, /已取消/)
    assert.doesNotMatch(err.message, /sk-/)
    assert.doesNotMatch(err.message, /Bearer\s+(?!\[REDACTED])/i)
    return true
  })
})

test('already-aborted signal rejects with 已取消', async () => {
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    () =>
      createImagesClient({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'testdata' }).generate({
        prompt: 'x',
        size: '1024x1024',
        model: 'gpt-image-2',
        references: [],
        signal: ac.signal,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /已取消/)
      return true
    },
  )
})

test('HTTP failures throw mapped redacted errors', async (t) => {
  const { baseUrl } = await listen(t, async (req, res) => {
    const url = req.url ?? ''
    await readBody(req)
    if (url.includes('generations')) {
      res.writeHead(401, { 'Content-Type': 'text/plain' })
      res.end('invalid api key sk-leakedsecret')
      return
    }
    res.writeHead(500)
    res.end()
  })

  await assert.rejects(
    () =>
      client(baseUrl).generate({
        prompt: 'x',
        size: '1024x1024',
        model: 'gpt-image-2',
        references: [],
        signal: new AbortController().signal,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, '图像 API 密钥无效或未配置')
      assert.doesNotMatch(err.message, /sk-/)
      return true
    },
  )
})

test('HTTP 429 and 400-model throw mapped errors; secrets are redacted', async (t) => {
  let n = 0
  const { baseUrl } = await listen(t, async (req, res) => {
    await readBody(req)
    n += 1
    if (n === 1) {
      res.writeHead(429)
      res.end('rate limited')
      return
    }
    if (n === 2) {
      res.writeHead(400)
      res.end('the model does not exist')
      return
    }
    res.writeHead(500)
    res.end('upstream Bearer leaked-token boom sk-othersecret')
  })

  const images = client(baseUrl)
  const input = {
    prompt: 'x',
    size: '1024x1024' as const,
    model: 'gpt-image-2',
    references: [] as typeof PNG_REF[],
    signal: new AbortController().signal,
  }

  await assert.rejects(() => images.generate(input), (err: unknown) => {
    assert.ok(err instanceof Error)
    assert.equal(err.message, '额度或速率限制')
    return true
  })
  await assert.rejects(() => images.generate(input), (err: unknown) => {
    assert.ok(err instanceof Error)
    assert.equal(err.message, '模型不支持')
    return true
  })
  await assert.rejects(() => images.generate(input), (err: unknown) => {
    assert.ok(err instanceof Error)
    assert.doesNotMatch(err.message, /sk-/)
    assert.doesNotMatch(err.message, /leaked-token/)
    assert.doesNotMatch(err.message, /sk-othersecret/)
    assert.match(err.message, /\[REDACTED\]/)
    return true
  })
})

test('mapImageError maps 401, 429, and 400-model', () => {
  assert.deepEqual(mapImageError(401, 'anything'), {
    ok: false,
    error: '图像 API 密钥无效或未配置',
  })
  assert.deepEqual(mapImageError(429, 'anything'), {
    ok: false,
    error: '额度或速率限制',
  })
  assert.deepEqual(mapImageError(503, '预扣费额度失败 remaining 0.12 need 0.17'), {
    ok: false,
    error: '额度或速率限制',
  })
  assert.deepEqual(mapImageError(503, '用户额度不足, 剩余额度: ¥-0.000034'), {
    ok: false,
    error: '额度或速率限制',
  })
  assert.deepEqual(mapImageError(400, 'unknown model xyz'), {
    ok: false,
    error: '模型不支持',
  })
  const other = mapImageError(400, 'bad request')
  assert.equal(other.ok, false)
  assert.notEqual(other.error, '模型不支持')
})

test('injected fetch is used', async () => {
  let called = false
  const fetchImpl: typeof fetch = async (_input, _init) => {
    called = true
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const images = createImagesClient({
    baseUrl: 'http://example.test/v1',
    apiKey: 'testdata',
    fetch: fetchImpl,
  })
  const result = await images.generate({
    prompt: 'x',
    size: '1024x1024',
    model: 'gpt-image-2',
    references: [],
    signal: new AbortController().signal,
  })
  assert.equal(called, true)
  assert.equal(result.mediaType, 'image/png')
  assert.ok(Buffer.from(result.bytes).equals(PNG))
})

test('readImageFile accepts 1x1 PNG and rejects oversize bytes/edges', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mxpage-img-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const okPath = join(dir, 'one.png')
  writeFileSync(okPath, PNG)
  const got = readImageFile(okPath)
  assert.equal(got.mediaType, 'image/png')
  assert.ok(Buffer.from(got.bytes).equals(PNG))

  const edgeOk = join(dir, 'edge.png')
  writeFileSync(edgeOk, pngHeader(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
  assert.equal(readImageFile(edgeOk).mediaType, 'image/png')

  const tooBig = join(dir, 'too-big.bin')
  writeFileSync(tooBig, Buffer.alloc(MAX_IMAGE_BYTES + 1))
  assert.throws(() => readImageFile(tooBig), /20MiB/)

  const tooWide = join(dir, 'wide.png')
  writeFileSync(tooWide, pngHeader(MAX_IMAGE_EDGE + 1, 1))
  assert.throws(() => readImageFile(tooWide), /8192/)

  const tooTall = join(dir, 'tall.jpg')
  writeFileSync(tooTall, jpegSof(1, MAX_IMAGE_EDGE + 1))
  assert.throws(() => readImageFile(tooTall), /8192/)
})

test('when /images/generations is unsupported, falls back to chat image output', async (t) => {
  const urls: string[] = []
  const { baseUrl } = await listen(t, async (req, res) => {
    urls.push(req.url ?? '')
    await readBody(req)
    if ((req.url ?? '').includes('/images/generations')) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: "Provider 'openai-compatible-chat' does not support image generation" },
      }))
      return
    }
    if ((req.url ?? '').includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: `Here you go:\n![image](data:image/png;base64,${PNG_B64})` },
        }],
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const result = await client(baseUrl).generate({
    prompt: 'a product photo',
    size: '1024x1024',
    model: 'novai/gemini-2.5-flash-image',
    references: [],
    signal: new AbortController().signal,
  })
  assert.ok(urls.some((u) => (u ?? '').endsWith('/images/generations')), String(urls))
  assert.ok(urls.some((u) => (u ?? '').endsWith('/chat/completions')), String(urls))
  assert.equal(result.mediaType, 'image/png')
  assert.ok(Buffer.from(result.bytes).equals(PNG))
})

test('withQuotaFallback retries generate after 额度或速率限制', async () => {
  let primaryCalls = 0
  const primary = {
    async generate() {
      primaryCalls += 1
      throw new Error('额度或速率限制')
    },
    async edit() {
      throw new Error('额度或速率限制')
    },
  }
  const fallback = {
    async generate() {
      return { bytes: new Uint8Array(PNG), mediaType: 'image/png' as const }
    },
    async edit() {
      return { bytes: new Uint8Array(PNG), mediaType: 'image/png' as const }
    },
  }
  const images = withQuotaFallback(primary, fallback)
  const result = await images.generate({
    prompt: 'x',
    size: '1024x1024',
    model: 'gpt-image-2',
    references: [],
    signal: new AbortController().signal,
  })
  assert.equal(primaryCalls, 1)
  assert.ok(Buffer.from(result.bytes).equals(PNG))
})

test('withQuotaFallback does not swallow non-quota errors', async () => {
  const primary = {
    async generate() {
      throw new Error('图像 API 密钥无效或未配置')
    },
    async edit() {
      throw new Error('图像 API 密钥无效或未配置')
    },
  }
  const fallback = {
    async generate() {
      return { bytes: new Uint8Array(PNG), mediaType: 'image/png' as const }
    },
    async edit() {
      return { bytes: new Uint8Array(PNG), mediaType: 'image/png' as const }
    },
  }
  await assert.rejects(
    () => withQuotaFallback(primary, fallback).generate({
      prompt: 'x',
      size: '1024x1024',
      model: 'gpt-image-2',
      references: [],
      signal: new AbortController().signal,
    }),
    /图像 API 密钥无效或未配置/,
  )
})

test('imagesClientFromEnv falls back to local mock after quota on primary', async (t) => {
  const prevUrl = process.env.MXPAGE_IMAGE_FALLBACK_BASE_URL
  const prevKey = process.env.MXPAGE_IMAGE_FALLBACK_API_KEY
  t.after(() => {
    if (prevUrl === undefined) delete process.env.MXPAGE_IMAGE_FALLBACK_BASE_URL
    else process.env.MXPAGE_IMAGE_FALLBACK_BASE_URL = prevUrl
    if (prevKey === undefined) delete process.env.MXPAGE_IMAGE_FALLBACK_API_KEY
    else process.env.MXPAGE_IMAGE_FALLBACK_API_KEY = prevKey
  })

  const { baseUrl: primaryUrl } = await listen(t, async (req, res) => {
    await readBody(req)
    res.writeHead(429)
    res.end('insufficient_user_quota')
  })
  const { baseUrl: fallbackUrl } = await listen(t, async (req, res) => {
    await readBody(req)
    sendPng(res)
  })

  process.env.MXPAGE_TEST_IMAGE_KEY = 'testdata'
  process.env.MXPAGE_IMAGE_FALLBACK_BASE_URL = fallbackUrl
  process.env.MXPAGE_IMAGE_FALLBACK_API_KEY = 'fallback-key'
  t.after(() => {
    delete process.env.MXPAGE_TEST_IMAGE_KEY
  })

  const images = imagesClientFromEnv({
    imageBaseUrl: primaryUrl,
    imageApiKeyEnv: 'MXPAGE_TEST_IMAGE_KEY',
  })
  assert.ok(images)
  const result = await images!.generate({
    prompt: 'x',
    size: '1024x1024',
    model: 'gpt-image-2',
    references: [],
    signal: new AbortController().signal,
  })
  assert.ok(Buffer.from(result.bytes).equals(PNG))
})

test('sniffImageMediaType distinguishes jpeg magic from png', () => {
  assert.equal(sniffImageMediaType(new Uint8Array(PNG)), 'image/png')
  assert.equal(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), 'image/jpeg')
})

test('quota 503 用户额度不足 skips chat fallback and maps to 额度', async (t) => {
  const urls: string[] = []
  const { baseUrl } = await listen(t, async (req, res) => {
    urls.push(req.url ?? '')
    await readBody(req)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '用户额度不足, 剩余额度: ¥-0.000034' } }))
  })
  await assert.rejects(
    () => client(baseUrl).generate({
      prompt: 'x',
      size: '1024x1024',
      model: 'novai/gemini-3.1-flash-lite-image',
      references: [],
      signal: new AbortController().signal,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, '额度或速率限制')
      return true
    },
  )
  assert.ok(urls.some((u) => (u ?? '').includes('/images/generations')), String(urls))
  assert.equal(urls.filter((u) => (u ?? '').includes('/chat/completions')).length, 0)
})

test('jpeg bytes are labeled image/jpeg so saveImage will accept them', async (t) => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])
  const { baseUrl } = await listen(t, async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: jpeg.toString('base64') }] }))
  })
  const result = await client(baseUrl).generate({
    prompt: 'x',
    size: '1024x1024',
    model: 'gpt-image-2',
    references: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.mediaType, 'image/jpeg')
})
