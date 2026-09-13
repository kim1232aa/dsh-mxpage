/**
 * v0.3 feature coverage — the MxPage parity additions.
 *
 * Covers, against the REAL runtime + a local mock upstream:
 *   - usage monitor: ledger normalize → summarize → humanize → host read/clear/delete
 *   - mxpage_translate_page: full analyze → plan → generate → translate-job chain
 *   - mxpage_delete_project / mxpage_update_project / mxpage_set_main_asset
 *   - routes: batch-create, providers test/discover, monitor usage, tasks retry
 *
 * Anything route-level goes through `makeMxpageRoutes` handlers invoked with
 * the host's real two-argument call shape (the smoke test guards the wiring;
 * this file guards the behavior).
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Config } from '../src/config.ts'
import {
  classifyQuotaState,
  humanizeApiMonitorMessage,
  normalizeLedgerEntry,
  summarizeUsage,
} from '../src/core/monitor/api-usage.ts'
import { createMxpageRuntime, type MxpageRuntime } from '../src/host/index.ts'
import { makeMxpageRoutes } from '../src/host/routes.ts'
import {
  clearUsageEntries,
  deleteUsageEntry,
  readUsageEntries,
} from '../src/host/usage-monitor.ts'
import { registerMxpageTools } from '../src/tools/register.ts'

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ---------------------------------------------------------------------------
// mock upstream (same shape as e2e.test.ts)
// ---------------------------------------------------------------------------

async function startMockServer(): Promise<{ baseUrl: string; calls: string[]; close(): Promise<void> }> {
  const calls: string[] = []
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = req.url ?? ''
      const bodyText = Buffer.concat(chunks).toString('utf8')
      calls.push(`${req.method} ${url}`)
      const json = (payload: unknown, status = 200) => {
        const text = JSON.stringify(payload)
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
        res.end(text)
      }

      if (url.endsWith('/models')) {
        json({
          data: [
            { id: 'mock-vision', object: 'model' },
            { id: 'mock-image-1', object: 'model' },
            { id: 'gpt-4o-mini', object: 'model' },
          ],
        })
        return
      }
      if (url.endsWith('/chat/completions')) {
        let userPrompt = ''
        try {
          const parsed = JSON.parse(bodyText) as { messages?: Array<{ content?: unknown }> }
          userPrompt = (parsed.messages ?? [])
            .map((message) =>
              typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
            )
            .join('\n')
        } catch {
          userPrompt = bodyText
        }
        if (userPrompt.includes('Visual Prompt Agent')) {
          json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    analysisSummary: 'mock vpa',
                    finalPrompt:
                      'A polished mobile commerce hero image with a bold Chinese headline and clean studio backdrop.',
                    negativePrompt: 'no garbled text',
                    qualityChecklist: ['clear headline'],
                  }),
                },
              },
            ],
          })
          return
        }
        if (userPrompt.includes('visualStyleGuide')) {
          const section = (order: number, type: string) => ({
            sectionKey: `${type}_${order}`,
            type,
            title: `${type} ${order}`,
            goal: 'mock goal',
            copy: 'mock copy',
            visualPrompt: 'mock prompt',
            order,
          })
          json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    visualStyleGuide: {
                      styleName: 'mock 风格',
                      colorPalette: '暖白',
                      backgroundSystem: '浅色',
                      lighting: '柔和',
                      cameraLanguage: '中焦',
                      typography: '黑体',
                      layoutRules: '安全边距',
                      propRules: '少量道具',
                      productRenderingRules: '保持一致',
                      negativeStyleConstraints: '禁止跳变',
                    },
                    sections: [section(1, 'hero'), section(2, 'selling_points')],
                  }),
                },
              },
            ],
          })
          return
        }
        json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  productName: '测试保温杯',
                  category: '家居日用',
                  subcategory: '杯壶',
                  material: '304 不锈钢',
                  color: '哑光白',
                  styleTags: ['简约'],
                  targetAudience: ['上班族'],
                  usageScenarios: ['办公室'],
                  coreSellingPoints: ['保温 12 小时'],
                  differentiationPoints: ['轻量'],
                  userConcerns: ['是否漏水'],
                  recommendedFocusPoints: ['密封性'],
                  additionalInformation: '容量 500ml',
                  generationRequirements: '多角度',
                  suggestedSectionPlan: [{ type: 'hero', title: '头图', goal: '吸引' }],
                }),
              },
            },
          ],
        })
        return
      }
      if (url.endsWith('/images/generations') || url.endsWith('/images/edits')) {
        json({ data: [{ b64_json: TINY_PNG_B64, revised_prompt: 'mock revised' }] })
        return
      }
      json({ error: { message: `unhandled ${url}` } }, 404)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function buildConfig(store: string, baseUrl: string): Config {
  return {
    channels: [
      {
        id: 'mock',
        label: 'Mock',
        baseUrl,
        apiKey: 'sk-mock-key',
        models: ['mock-image-1', 'mock-vision'],
        textModel: 'mock-vision',
        imageModel: 'mock-image-1',
      },
    ],
    workspaceDir: store,
    defaultLanguage: 'zh-CN',
    defaultHeroCount: 1,
    defaultDetailCount: 1,
    defaultDetailAspectRatio: '3:4',
    defaultPlatform: 'taobao_tmall',
    defaultStyle: 'premium',
    analyzeTimeoutMs: 30_000,
    promptTimeoutMs: 30_000,
    imageTimeoutMs: 30_000,
    maxReferenceImages: 4,
    maxAnalysisImages: 10,
    maxParallelSections: 2,
    maxParallelProjects: 1,
    rotateChannelOnQuotaExhausted: true,
    allowSvgFallback: false,
  } as unknown as Config
}

// ---------------------------------------------------------------------------
// route invocation helper (host-realistic two-arg call)
// ---------------------------------------------------------------------------

async function callRoute(
  routes: ReturnType<typeof makeMxpageRoutes>,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  queryString = '',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routes.find((item) => item.path === path)
  assert.ok(route, `route not registered: ${path}`)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const fakeReq = {
    method,
    url: queryString ? `${path}?${queryString}` : path,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload)
    },
  }
  let status = 0
  let text = ''
  const fakeRes = {
    writeHead(code: number) {
      status = code
    },
    end(chunk?: string | Buffer) {
      text = String(chunk ?? '')
    },
  }
  await (route.handler as (req: unknown, res: unknown) => Promise<void>)(fakeReq, fakeRes)
  return { status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

function makePanel(runtime: MxpageRuntime, config: Config) {
  return makeMxpageRoutes({
    runtime,
    config,
    imageUrl: (relPath) => `/api/dsh-mxpage/image?path=${encodeURIComponent(relPath)}`,
  })
}

interface ToolLike {
  name: string
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<Record<string, unknown>>
}

function toolSet(runtime: MxpageRuntime, config: Config): Map<string, ToolLike> {
  const tools = new Map<string, ToolLike>()
  const ctx = {
    tools: {
      register(tool: ToolLike) {
        tools.set(tool.name, tool)
        return () => {}
      },
    },
    attachments: {
      async saveImage() {
        return { attachmentId: 'att_test' }
      },
      async readImage() {
        return { data: new Uint8Array([1]) }
      },
      imageHostPath: () => undefined,
    },
  }
  registerMxpageTools(ctx as never, config, runtime)
  return tools
}

/** Creates a project with one MAIN upload and returns its id. */
async function seedProject(runtime: MxpageRuntime, name: string): Promise<string> {
  const project = await runtime.host.repository.project.create({
    name,
    platform: 'taobao_tmall',
    style: 'premium',
  })
  await runtime.assets.saveUploadAsset({
    projectId: project.id,
    type: 'MAIN',
    fileName: 'main.png',
    mimeType: 'image/png',
    fileBuffer: Buffer.from(TINY_PNG_B64, 'base64'),
    sortOrder: 0,
    isMain: true,
  })
  return project.id
}

// ---------------------------------------------------------------------------
// usage monitor core
// ---------------------------------------------------------------------------

test('monitor: normalize + summarize classify quota and aggregate correctly', () => {
  const now = new Date().toISOString()
  const entries = [
    normalizeLedgerEntry(
      { at: now, endpoint: '/v1/images/generations', model: 'img-1', status: 200, ok: true, durationMs: 100, category: 'image_generation' },
      'a',
    )!,
    normalizeLedgerEntry(
      { at: now, endpoint: '/v1/chat/completions', model: 'text-1', status: 429, ok: false, durationMs: 40, category: 'text', errorMessage: 'rate limit reached' },
      'b',
    )!,
    normalizeLedgerEntry(
      { at: now, endpoint: '/v1/chat/completions', model: 'text-1', status: 401, ok: false, durationMs: 30, category: 'structured', errorMessage: 'insufficient_quota: 可用余额不足' },
      'c',
    )!,
    // outside the default 24h window? no — but mark one clearly old entry out
    normalizeLedgerEntry(
      { at: new Date(Date.now() - 48 * 3600_000).toISOString(), endpoint: '/v1/models', status: 200, ok: true, durationMs: 10, category: 'models' },
      'd',
    )!,
  ]
  assert.equal(entries.length, 4)
  assert.equal(entries[1]!.quotaState, 'rate_limited')
  assert.equal(entries[2]!.quotaState, 'spending_limited')

  const summary = summarizeUsage(entries, { hours: 24, limit: 10 })
  assert.equal(summary.totalRequests, 3, 'the 48h-old entry falls outside the window')
  assert.equal(summary.successRequests, 1)
  assert.equal(summary.failedRequests, 2)
  assert.equal(summary.imageRequests, 1)
  assert.equal(summary.chatRequests, 2)
  assert.equal(summary.rateLimitedRequests, 1)
  assert.equal(summary.spendingLimitedRequests, 1)
  assert.equal(summary.topModels[0]!.model, 'text-1')
  assert.equal(summary.recentEntries.length, 3)

  const failedOnly = summarizeUsage(entries, { hours: 24, success: 'failed' })
  assert.equal(failedOnly.totalRequests, 2)

  assert.equal(classifyQuotaState(200, ''), 'ok')
  assert.match(humanizeApiMonitorMessage({ message: 'insufficient_quota', statusCode: 429 }) ?? '', /额度/)
  assert.match(humanizeApiMonitorMessage({ message: null, statusCode: 401 }) ?? '', /API Key/)
})

test('monitor: host ledger read/delete/clear round-trips with stable ids', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-usage-'))
  try {
    const lines = [
      { at: new Date().toISOString(), endpoint: '/v1/a', status: 200, ok: true, category: 'text' },
      { at: new Date().toISOString(), endpoint: '/v1/b', status: 500, ok: false, category: 'image_generation', errorMessage: 'boom' },
    ]
    writeFileSync(join(store, 'usage.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    const first = await readUsageEntries(store)
    assert.equal(first.length, 2)
    assert.equal(first[0]!.endpoint, '/v1/b', 'newest first')

    const second = await readUsageEntries(store)
    assert.equal(first[0]!.id, second[0]!.id, 'derived ids are stable across reads')

    const doomed = first[0]!.id
    assert.deepEqual(await deleteUsageEntry(store, doomed), { deleted: true })
    const after = await readUsageEntries(store)
    assert.equal(after.length, 1)
    assert.equal(after[0]!.endpoint, '/v1/a')
    assert.deepEqual(await deleteUsageEntry(store, doomed), { deleted: false })

    assert.deepEqual(await clearUsageEntries(store), { cleared: true })
    assert.equal((await readUsageEntries(store)).length, 0)
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// translate-page tool, end to end
// ---------------------------------------------------------------------------

test('translate-page: generated sections get translate-edited into new versions', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-v03-'))
  const server = await startMockServer()
  try {
    const config = buildConfig(store, server.baseUrl)
    const runtime = createMxpageRuntime(config)
    const tools = toolSet(runtime, config)

    const projectId = await seedProject(runtime, 'translate-e2e')
    await runtime.analysis.analyzeProject(projectId, null)
    await runtime.planner.planSections(projectId, {
      modelId: null,
      previewConfig: {
        heroImageCount: 1,
        detailSectionCount: 1,
        imageAspectRatio: '3:4',
        contentLanguage: 'zh-CN' as never,
      },
    })
    const sections = await runtime.host.repository.section.list(projectId)
    assert.equal(sections.length, 2)
    for (const section of sections) {
      await runtime.generation.generateSectionImage(projectId, section.id)
    }

    const translate = tools.get('mxpage_translate_page')!
    const started = await translate.execute({ project_id: projectId, target_language: 'en-US' }, {})
    assert.equal(started.ok, true)
    assert.equal(started.kind, 'background')
    assert.equal(started.total, 2)

    const jobId = started.jobId as string
    const handle = runtime.runner.get!(jobId)
    assert.ok(handle, 'job handle must be live right after start')
    await handle.done

    assert.equal(runtime.runner.status!(jobId), 'completed')
    for (const section of sections) {
      const versions = await runtime.host.repository.version.list(section.id)
      assert.equal(versions.length, 2, `section ${section.id}: generate v1 + translate v2`)
      assert.equal(versions.find((version) => version.isActive)?.versionNumber, 2)
    }
    assert.ok(
      server.calls.some((call) => call.includes('/images/edits')),
      'translate goes through the image edit endpoint',
    )

    // translate with nothing generated → readable business failure
    const emptyId = await seedProject(runtime, 'translate-empty')
    const refused = await translate.execute({ project_id: emptyId, target_language: 'en-US' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'MXPAGE_STATE')
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// project management tools
// ---------------------------------------------------------------------------

test('project tools: update renames, delete removes record AND workspace files', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-v03-'))
  const server = await startMockServer()
  try {
    const config = buildConfig(store, server.baseUrl)
    const runtime = createMxpageRuntime(config)
    const tools = toolSet(runtime, config)

    const projectId = await seedProject(runtime, 'before-name')

    const update = tools.get('mxpage_update_project')!
    const updated = await update.execute({ project_id: projectId, name: 'after-name' })
    assert.equal(updated.ok, true)
    assert.equal(updated.name, 'after-name')
    assert.equal((await runtime.host.repository.project.get(projectId))!.name, 'after-name')

    // files exist before delete
    const uploadsDir = join(store, 'uploads', projectId)
    assert.ok(existsSync(uploadsDir))
    assert.ok(readdirSync(uploadsDir).length > 0)

    const del = tools.get('mxpage_delete_project')!
    // defineTool rejects a missing required param before execute runs…
    await assert.rejects(del.execute({ project_id: projectId }, {}), /confirm/)
    // …and the business guard rejects confirm: false
    const unconfirmed = await del.execute({ project_id: projectId, confirm: false }, {})
    assert.equal(unconfirmed.ok, false)
    assert.equal(unconfirmed.error, 'MXPAGE_CONFIRM')

    const confirmed = await del.execute({ project_id: projectId, confirm: true })
    assert.equal(confirmed.ok, true)
    assert.equal(await runtime.host.repository.project.get(projectId), null)
    assert.ok(!existsSync(uploadsDir), 'workspace upload dir removed with the project')

    const gone = await del.execute({ project_id: projectId, confirm: true })
    assert.equal(gone.ok, false)
    assert.equal(gone.error, 'MXPAGE_NOT_FOUND')
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

test('set-main tool: by asset_id and by image_path', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-v03-'))
  const server = await startMockServer()
  try {
    const config = buildConfig(store, server.baseUrl)
    const runtime = createMxpageRuntime(config)
    const tools = toolSet(runtime, config)

    const projectId = await seedProject(runtime, 'set-main')
    const second = await runtime.assets.saveUploadAsset({
      projectId,
      type: 'REFERENCE',
      fileName: 'second.png',
      mimeType: 'image/png',
      fileBuffer: Buffer.from(TINY_PNG_B64, 'base64'),
      sortOrder: 1,
      isMain: false,
    })

    const setMain = tools.get('mxpage_set_main_asset')!
    const byPath = await setMain.execute({ project_id: projectId, image_path: second.filePath })
    assert.equal(byPath.ok, true)
    let assets = await runtime.host.repository.asset.list({ projectId })
    assert.equal(assets.find((asset) => asset.isMain)?.id, second.id)

    const first = assets.find((asset) => asset.fileName === 'main.png')!
    const byId = await setMain.execute({ project_id: projectId, asset_id: first.id })
    assert.equal(byId.ok, true)
    assets = await runtime.host.repository.asset.list({ projectId })
    assert.equal(assets.find((asset) => asset.isMain)?.id, first.id)

    const missing = await setMain.execute({ project_id: projectId, image_path: 'nope.png' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'MXPAGE_NOT_FOUND')
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

test('usage-stats tool reads the ledger the logger writes', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-v03-'))
  const server = await startMockServer()
  try {
    const config = buildConfig(store, server.baseUrl)
    const runtime = createMxpageRuntime(config)
    const tools = toolSet(runtime, config)

    // one real call through the adapter writes one ledger line
    await runtime.host.provider.resolve({ operation: 'test' })
    const projectId = await seedProject(runtime, 'usage')
    await runtime.analysis.analyzeProject(projectId, null)

    const stats = tools.get('mxpage_usage_stats')!
    const result = await stats.execute({ hours: 1 })
    assert.equal(result.ok, true)
    assert.ok((result.totalRequests as number) >= 1, 'at least the analysis call is counted')
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// routes: batch-create / providers / monitor / tasks
// ---------------------------------------------------------------------------

test('route batch-create makes one project per SKU with a MAIN asset', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-v03-'))
  const server = await startMockServer()
  try {
    const config = buildConfig(store, server.baseUrl)
    const runtime = createMxpageRuntime(config)
    const routes = makePanel(runtime, config)

    const item = (name: string) => ({
      name,
      fileName: `${name}.png`,
      mimeType: 'image/png',
      base64Data: TINY_PNG_B64,
    })
    const { json } = await callRoute(routes, '/api/dsh-mxpage/batch-create', 'POST', {
      items: [item('sku-a'), item('sku-b')],
    })
    assert.equal(json.ok, true)
    const projects = json.projects as Array<{ projectId: string; name: string }>
    assert.equal(projects.length, 2)
    assert.equal(json.jobId, null, 'no auto-analyze → no background job')

    for (const created of projects) {
      const assets = await runtime.host.repository.asset.list({ projectId: created.projectId })
      assert.equal(assets.length, 1)
      assert.equal(assets[0]!.type, 'MAIN')
      assert.equal(assets[0]!.isMain, true)
      const snapshot = (await runtime.host.repository.project.get(created.projectId))!.modelSnapshot
      assert.ok(snapshot?.previewConfig, 'preview config scaffolded like single-create')
    }

    const rejected = await callRoute(routes, '/api/dsh-mxpage/batch-create', 'POST', { items: [] })
    assert.equal(rejected.json.ok, false)
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

test('route providers discover/test hit the mock upstream and classify models', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-v03-'))
  const server = await startMockServer()
  try {
    const config = buildConfig(store, server.baseUrl)
    const runtime = createMxpageRuntime(config)
    const routes = makePanel(runtime, config)

    const discover = await callRoute(routes, '/api/dsh-mxpage/providers/discover', 'POST', {
      channelId: 'mock',
    })
    assert.equal(discover.json.ok, true)
    const models = discover.json.models as Array<{ modelId: string; capabilities: Record<string, unknown> }>
    assert.ok(models.length >= 3)
    assert.ok(
      models.some((model) => model.capabilities.image_gen || model.capabilities.image_edit),
      'mock-image-1 classified as image-capable',
    )
    const recommendations = discover.json.recommendations as Record<string, unknown>
    assert.ok('analysisModelId' in recommendations)

    const tested = await callRoute(routes, '/api/dsh-mxpage/providers/test', 'POST', {
      channelId: 'mock',
    })
    assert.equal(tested.json.ok, true, JSON.stringify(tested.json))

    const unknown = await callRoute(routes, '/api/dsh-mxpage/providers/test', 'POST', {
      channelId: 'nope',
    })
    assert.equal(unknown.json.ok, false)
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

test('route monitor usage serves summary and supports delete/clear', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-v03-'))
  const server = await startMockServer()
  try {
    const config = buildConfig(store, server.baseUrl)
    const runtime = createMxpageRuntime(config)
    const routes = makePanel(runtime, config)

    // generate real ledger lines through the adapter
    const projectId = await seedProject(runtime, 'monitor-route')
    await runtime.analysis.analyzeProject(projectId, null)
    // the file logger appends asynchronously — give it a tick
    await new Promise((resolve) => setTimeout(resolve, 100))

    const summary = await callRoute(routes, '/api/dsh-mxpage/monitor/usage', 'GET', undefined, 'hours=1')
    assert.equal(summary.json.ok, true)
    const body = summary.json.summary as { totalRequests: number; recentEntries: Array<{ id: string }> }
    assert.ok(body.totalRequests >= 1, `expected ledger entries, got ${body.totalRequests}`)

    const doomed = body.recentEntries[0]!.id
    const deleted = await callRoute(routes, '/api/dsh-mxpage/monitor/usage/delete', 'POST', { id: doomed })
    assert.equal(deleted.json.ok, true)
    assert.equal(deleted.json.deleted, true)

    const cleared = await callRoute(routes, '/api/dsh-mxpage/monitor/usage/clear', 'POST')
    assert.equal(cleared.json.cleared, true)
    const empty = await callRoute(routes, '/api/dsh-mxpage/monitor/usage', 'GET', undefined, 'hours=1')
    assert.equal((empty.json.summary as { totalRequests: number }).totalRequests, 0)
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

test('route tasks retry re-runs a failed section generation', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-v03-'))
  const server = await startMockServer()
  try {
    const config = buildConfig(store, server.baseUrl)
    const runtime = createMxpageRuntime(config)
    const routes = makePanel(runtime, config)

    const projectId = await seedProject(runtime, 'retry-route')
    await runtime.analysis.analyzeProject(projectId, null)
    await runtime.planner.planSections(projectId, {
      modelId: null,
      previewConfig: {
        heroImageCount: 1,
        detailSectionCount: 1,
        imageAspectRatio: '3:4',
        contentLanguage: 'zh-CN' as never,
      },
    })
    const [section] = await runtime.host.repository.section.list(projectId)

    // a FAILED GENERATE task pointing at the section
    const task = await runtime.host.repository.task.create({
      projectId,
      sectionId: section!.id,
      taskType: 'GENERATE',
      status: 'FAILED',
      inputPayload: { projectId, sectionId: section!.id },
    })

    const list = await callRoute(routes, '/api/dsh-mxpage/tasks', 'GET', undefined, `projectId=${projectId}`)
    assert.equal(list.json.ok, true)
    assert.ok((list.json.tasks as unknown[]).length >= 1)

    const retried = await callRoute(routes, '/api/dsh-mxpage/tasks/retry', 'POST', { taskId: task.id })
    assert.equal(retried.json.ok, true, JSON.stringify(retried.json))
    assert.equal(retried.json.retried, true)
    const versions = await runtime.host.repository.version.list(section!.id)
    assert.equal(versions.length, 1, 'retry produced the section image')

    // a RUNNING task refuses to retry
    const running = await runtime.host.repository.task.create({
      projectId,
      taskType: 'GENERATE',
      status: 'RUNNING',
    })
    const refused = await callRoute(routes, '/api/dsh-mxpage/tasks/retry', 'POST', { taskId: running.id })
    assert.equal(refused.json.ok, false)
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

test('route project/asset management: update, reorder, set-main, delete-asset, delete-project', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-v03-'))
  const server = await startMockServer()
  try {
    const config = buildConfig(store, server.baseUrl)
    const runtime = createMxpageRuntime(config)
    const routes = makePanel(runtime, config)

    const projectId = await seedProject(runtime, 'mgmt')
    const extra = await runtime.assets.saveUploadAsset({
      projectId,
      type: 'REFERENCE',
      fileName: 'extra.png',
      mimeType: 'image/png',
      fileBuffer: Buffer.from(TINY_PNG_B64, 'base64'),
      sortOrder: 1,
      isMain: false,
    })

    const updated = await callRoute(routes, '/api/dsh-mxpage/project/update', 'POST', {
      id: projectId,
      name: 'mgmt-renamed',
    })
    assert.equal(updated.json.ok, true)

    const assets = await runtime.host.repository.asset.list({ projectId })
    const reversed = [...assets].reverse().map((asset) => asset.id)
    const reordered = await callRoute(routes, '/api/dsh-mxpage/assets/reorder', 'POST', {
      projectId,
      orderedAssetIds: reversed,
    })
    assert.equal(reordered.json.ok, true)
    const after = await runtime.host.repository.asset.list({ projectId })
    assert.equal(after[0]!.id, reversed[0])

    const setMain = await callRoute(routes, '/api/dsh-mxpage/assets/set-main', 'POST', {
      projectId,
      assetId: extra.id,
    })
    assert.equal(setMain.json.ok, true)

    // referenced assets refuse deletion: generate a section image first
    await runtime.analysis.analyzeProject(projectId, null)
    await runtime.planner.planSections(projectId, {
      modelId: null,
      previewConfig: {
        heroImageCount: 1,
        detailSectionCount: 1,
        imageAspectRatio: '3:4',
        contentLanguage: 'zh-CN' as never,
      },
    })
    const [section] = await runtime.host.repository.section.list(projectId)
    const generated = await runtime.generation.generateSectionImage(projectId, section!.id)
    const refused = await callRoute(routes, '/api/dsh-mxpage/assets/delete', 'POST', {
      assetId: generated.imageAsset.id,
    })
    assert.equal(refused.json.ok, false, 'referenced asset refuses deletion')

    const removed = await callRoute(routes, '/api/dsh-mxpage/assets/delete', 'POST', { assetId: extra.id })
    assert.equal(removed.json.ok, true)
    assert.equal(await runtime.host.repository.asset.get(extra.id), null)

    const gone = await callRoute(routes, '/api/dsh-mxpage/project/delete', 'POST', { id: projectId })
    assert.equal(gone.json.ok, true)
    assert.equal(await runtime.host.repository.project.get(projectId), null)
    assert.ok(!existsSync(join(store, 'uploads', projectId)))
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

test('route analysis-save persists panel edits and translate route starts a job', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-v03-'))
  const server = await startMockServer()
  try {
    const config = buildConfig(store, server.baseUrl)
    const runtime = createMxpageRuntime(config)
    const routes = makePanel(runtime, config)

    const projectId = await seedProject(runtime, 'analysis-route')
    await runtime.analysis.analyzeProject(projectId, null)

    // the panel edits the FULL normalized analysis, not a fragment
    const full = (await runtime.host.repository.analysis.get(projectId))!
      .normalizedResult as Record<string, unknown>
    const saved = await callRoute(routes, '/api/dsh-mxpage/analysis/save', 'POST', {
      projectId,
      analysis: { ...full, productName: '手工改过的名字' },
    })
    assert.equal(saved.json.ok, true)
    const stored = await runtime.host.repository.analysis.get(projectId)
    assert.equal((stored!.normalizedResult as Record<string, unknown>).productName, '手工改过的名字')

    // translate route: no generated sections yet → readable failure
    const early = await callRoute(routes, '/api/dsh-mxpage/translate-page', 'POST', {
      projectId,
      targetLanguage: 'en-US',
    })
    assert.equal(early.json.ok, false)

    await runtime.planner.planSections(projectId, {
      modelId: null,
      previewConfig: {
        heroImageCount: 1,
        detailSectionCount: 1,
        imageAspectRatio: '3:4',
        contentLanguage: 'zh-CN' as never,
      },
    })
    const [section] = await runtime.host.repository.section.list(projectId)
    await runtime.generation.generateSectionImage(projectId, section!.id)

    const started = await callRoute(routes, '/api/dsh-mxpage/translate-page', 'POST', {
      projectId,
      targetLanguage: 'en-US',
    })
    assert.equal(started.json.ok, true)
    const jobId = started.json.jobId as string
    await runtime.runner.get!(jobId)!.done
    const versions = await runtime.host.repository.version.list(section!.id)
    assert.equal(versions.length, 2)
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})
