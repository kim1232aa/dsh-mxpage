/**
 * End-to-end pipeline verification.
 *
 * Runs the real core services against a local OpenAI-compatible mock server, so
 * the whole chain is exercised for real: HTTP → adapter → prompts → schemas →
 * repository → storage → attachment bytes.
 *
 * This is the strongest check available without the user's credentials and
 * without restarting the DSH profile, and it covers exactly what the objective
 * names: analyze → plan → Visual Prompt Agent → generate, plus on-disk output.
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Config } from '../src/config.ts'
import { createAnalysisService } from '../src/core/services/analysis-service.ts'
import { createAssetStore } from '../src/core/services/asset-store.ts'
import { createGenerationService } from '../src/core/services/generation-service.ts'
import { createPlannerService } from '../src/core/services/planner-service.ts'
import { createTaskService } from '../src/core/services/task-service.ts'
import type { CoreHost } from '../src/core/ports/index.ts'
import { createMxpageRuntime } from '../src/host/index.ts'
import { createFileLogger } from '../src/host/logger.ts'
import { createProviderResolver } from '../src/host/provider-resolver.ts'
import { createJsonRepository } from '../src/host/repository.ts'
import { createFileStorageDriver } from '../src/host/storage-driver.ts'
import { createQueuedTaskRunner } from '../src/host/task-runner.ts'
import { registerMxpageTools } from '../src/tools/register.ts'

/** 1×1 transparent PNG. */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ---------------------------------------------------------------------------
// mock upstream
// ---------------------------------------------------------------------------

interface MockServer {
  baseUrl: string
  calls: string[]
  close(): Promise<void>
}

/**
 * A minimal OpenAI-compatible endpoint. Routes `/chat/completions` by sniffing
 * the prompt, because analysis, planning and the VPA all share that endpoint.
 */
async function startMockServer(): Promise<MockServer> {
  const calls: string[] = []

  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = req.url ?? ''
      const bodyText = Buffer.concat(chunks).toString('utf8')
      calls.push(`${req.method} ${url}`)

      const json = (payload: unknown) => {
        const text = JSON.stringify(payload)
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
        })
        res.end(text)
      }

      if (url.endsWith('/models')) {
        json({
          data: [
            { id: 'mock-vision', object: 'model' },
            { id: 'mock-image-1', object: 'model' },
          ],
        })
        return
      }

      if (url.endsWith('/chat/completions')) {
        let userPrompt = ''
        try {
          const parsed = JSON.parse(bodyText) as { messages?: Array<{ content?: unknown }> }
          const contents = (parsed.messages ?? []).map((message) =>
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          )
          userPrompt = contents.join('\n')
        } catch {
          userPrompt = bodyText
        }

        // Visual Prompt Agent
        if (userPrompt.includes('Visual Prompt Agent')) {
          json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    analysisSummary: 'mock vpa analysis',
                    finalPrompt:
                      'A polished mobile commerce hero image of the product on a soft studio backdrop, with a bold Chinese headline and two selling-point callouts.',
                    negativePrompt: 'no garbled text, no floating product',
                    qualityChecklist: ['clear headline', 'product in focus'],
                  }),
                },
              },
            ],
          })
          return
        }

        // Section planning
        if (userPrompt.includes('mobile detail-page planner')) {
          const section = (index: number, type: string) => ({
            id: `s${index}`,
            type,
            title: `分区 ${index}`,
            goal: `目标 ${index}`,
            copy: `文案 ${index}`,
            visualPrompt: 'Primary Prompt: 主视觉\nEnglish Prompt: main visual',
            editableFields: { styleRole: 'role', sharedStyleAnchors: ['a'], localVariation: 'v' },
          })
          json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    visualStyleGuide: {
                      styleName: 'mock 风格',
                      colorPalette: '暖白 + 深灰',
                      backgroundSystem: '统一浅色背景',
                      lighting: '柔和棚拍光',
                      cameraLanguage: '中焦段',
                      typography: '黑体标题',
                      layoutRules: '移动端安全边距',
                      propRules: '少量道具',
                      productRenderingRules: '保持商品一致',
                      negativeStyleConstraints: '禁止跳变',
                    },
                    sections: [
                      section(1, 'hero'),
                      section(2, 'hero'),
                      section(3, 'selling_points'),
                      section(4, 'scenario'),
                      section(5, 'detail_closeup'),
                      section(6, 'specs'),
                    ],
                  }),
                },
              },
            ],
          })
          return
        }

        // Product analysis
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
                  styleTags: ['简约', '通勤'],
                  targetAudience: ['上班族'],
                  usageScenarios: ['办公室', '通勤'],
                  coreSellingPoints: ['保温 12 小时', '一键开盖'],
                  differentiationPoints: ['轻量'],
                  userConcerns: ['是否漏水'],
                  recommendedFocusPoints: ['密封性'],
                  additionalInformation: '容量 500ml；待用户补充重量。',
                  generationRequirements: '多角度展示',
                  suggestedSectionPlan: [
                    { type: 'hero', title: '头图', goal: '第一眼吸引' },
                    { type: 'selling_points', title: '卖点', goal: '讲清优势' },
                    { type: 'scenario', title: '场景', goal: '代入使用' },
                    { type: 'detail_closeup', title: '细节', goal: '展示做工' },
                    { type: 'specs', title: '规格', goal: '参数说明' },
                    { type: 'summary', title: '收口', goal: '促成转化' },
                  ],
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

      json({ error: { message: `unhandled ${url}` } })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function buildHarness(store: string, baseUrl: string) {
  const config = {
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
    defaultHeroCount: 2,
    defaultDetailCount: 4,
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

  const logger = createFileLogger({ ledgerDir: store })
  const repository = createJsonRepository({ file: join(store, 'db.json') })
  const storage = createFileStorageDriver(store)
  const provider = createProviderResolver({ config, logger })
  const runner = createQueuedTaskRunner({ repository, concurrency: 2 })
  const host: Required<CoreHost> = { repository, storage, provider, logger, tasks: runner }

  const assets = createAssetStore(host)
  const tasks = createTaskService(host)
  return {
    config,
    host,
    assets,
    tasks,
    analysis: createAnalysisService(host, { taskService: tasks, assetStore: assets }),
    planner: createPlannerService(host, { tasks, assets }),
    generation: createGenerationService(host, { tasks, assets }),
  }
}

// ---------------------------------------------------------------------------

test('end-to-end: analyze -> plan -> VPA -> generate produces on-disk images', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-e2e-'))
  const server = await startMockServer()
  try {
    const h = buildHarness(store, server.baseUrl)

    // 1. project + a real product photo on disk
    const project = await h.host.repository.project.create({
      name: 'e2e',
      platform: 'taobao_tmall',
      style: 'premium',
    })
    const upload = await h.assets.saveUploadAsset({
      projectId: project.id,
      type: 'MAIN',
      fileName: 'main.png',
      mimeType: 'image/png',
      fileBuffer: Buffer.from(TINY_PNG_B64, 'base64'),
      sortOrder: 0,
      isMain: true,
    })
    assert.equal(upload.type, 'MAIN')

    // 2. analyze
    const analysis = await h.analysis.analyzeProject(project.id)
    const normalized = analysis.normalizedResult as { productName: string }
    assert.equal(normalized.productName, '测试保温杯')
    assert.equal((await h.host.repository.project.get(project.id))?.status, 'ANALYZED')

    // 3. plan
    const plan = await h.planner.planSections(project.id, {
      previewConfig: {
        heroImageCount: 2,
        detailSectionCount: 4,
        imageAspectRatio: '3:4',
        contentLanguage: 'zh-CN' as never,
      },
    })
    assert.equal(plan.sections.length, 6, '2 hero + 4 detail')
    assert.equal(plan.fallbackMode, undefined, 'the model answered, so no template fallback')
    assert.ok(
      (plan.visualStyleGuide as { styleName?: string }).styleName,
      'the style guide must survive planning',
    )
    assert.equal((await h.host.repository.project.get(project.id))?.status, 'PLANNED')

    // 4. generate one section (runs the VPA first)
    const hero = plan.sections.find((section) => section.type === 'HERO')
    assert.ok(hero)
    const generated = await h.generation.generateSectionImage(project.id, hero.id)
    assert.equal(generated.generationMode, 'image_api')
    assert.match(generated.usedModel, /mock-image/)

    // 5. on-disk evidence
    const generatedDir = join(store, 'generated', project.id, hero.id)
    assert.ok(statSync(generatedDir).isDirectory(), 'the generated directory must exist')
    const files = readdirSync(generatedDir)
    assert.equal(files.length, 1)
    const bytes = await h.assets.readStorageFile(generated.imageAsset.filePath)
    assert.equal(bytes.toString('base64'), TINY_PNG_B64, 'the bytes must round-trip exactly')

    // 6. version bookkeeping
    const versions = await h.generation.listSectionVersions(hero.id)
    assert.equal(versions.length, 1)
    assert.equal(versions[0]?.isActive, true)
    assert.ok(versions[0]?.imageAsset, 'the version must resolve its asset')

    // 7. the section now points at the image
    const refreshed = await h.host.repository.section.get(hero.id)
    assert.equal(refreshed?.currentImageAssetId, generated.imageAsset.id)
    assert.equal(refreshed?.status, 'SUCCESS')
    assert.equal((await h.host.repository.project.get(project.id))?.status, 'EDITING')

    // 8. the VPA really ran (its call went through /chat/completions)
    const chatCalls = server.calls.filter((call) => call.includes('/chat/completions'))
    assert.ok(
      chatCalls.length >= 3,
      `analysis + planning + VPA must all have called the model (saw ${server.calls.join(', ')})`,
    )
    // With a reference image present, upstream's reference-guided path uses
    // /images/edits rather than /images/generations — either proves the image
    // call happened.
    assert.ok(
      server.calls.some(
        (call) => call.includes('/images/edits') || call.includes('/images/generations'),
      ),
      `an image endpoint must have been called (saw ${server.calls.join(', ')})`,
    )
    // NOTE: no `/models` call is expected — this channel declares `models`
    // explicitly, and the resolver deliberately skips discovery in that case.
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

test('end-to-end: the tool layer returns a DSH attachment for a generated section', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-e2e3-'))
  const server = await startMockServer()
  try {
    const config = {
      channels: [
        {
          id: 'mock',
          baseUrl: server.baseUrl,
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
      defaultPlatform: 'general_ecommerce',
      defaultStyle: 'generic_clean',
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

    const runtime = createMxpageRuntime(config)

    // Go through the real tool registration, exactly as the DSH host does.
    const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
    const saved: Array<{ mediaType: string; bytes: number }> = []
    registerMxpageTools(
      {
        tools: {
          register(tool: unknown) {
            const typed = tool as { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }
            tools.set(typed.name, typed)
            return () => {}
          },
        },
        attachments: {
          async saveImage(input: { data: Uint8Array; mediaType: string }) {
            saved.push({ mediaType: input.mediaType, bytes: input.data.byteLength })
            return {
              attachmentId: `att_${saved.length}`,
              mediaType: input.mediaType,
              bytes: input.data.byteLength,
              width: 1,
              height: 1,
              name: 'section.png',
            }
          },
        },
      },
      config,
      runtime,
    )

    const exec = { signal: new AbortController().signal }
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.get(name)
      assert.ok(tool, `${name} must be registered`)
      return (await tool.execute(args, exec)) as Record<string, unknown>
    }

    // A product photo on disk, referenced by path — the workspace-file route.
    const imagePath = join(store, 'product.png')
    writeFileSync(imagePath, Buffer.from(TINY_PNG_B64, 'base64'))

    const created = await call('mxpage_create_project', {
      name: 'tool-e2e',
      image_paths: [imagePath],
    })
    assert.equal(created.ok, true)
    const projectId = created.projectId as string

    const analyzed = await call('mxpage_analyze_product', { project_id: projectId })
    assert.equal(analyzed.ok, true, `analyze failed: ${JSON.stringify(analyzed)}`)

    const planned = await call('mxpage_plan_page', {
      project_id: projectId,
      hero_count: 1,
      detail_count: 1,
    })
    assert.equal(planned.ok, true)
    const sections = planned.sections as Array<{ id: string; type: string }>
    const hero = sections.find((section) => section.type === 'HERO')
    assert.ok(hero)

    const generated = await call('mxpage_generate_section', {
      project_id: projectId,
      section_id: hero.id,
    })
    assert.equal(generated.ok, true)
    assert.match(String(generated.attachmentId), /^att_/, 'the tool must return a DSH attachment id')
    assert.equal(saved.length, 1)
    assert.equal(saved[0]?.mediaType, 'image/png')
    assert.ok((saved[0]?.bytes ?? 0) > 0, 'the attachment must carry real bytes')

    // And the same bytes exist on disk under the workspace root.
    const outputPath = String(generated.outputPath)
    assert.ok(
      (await runtime.assets.readStorageFile(outputPath)).byteLength > 0,
      'the file must also be on disk',
    )

    const exported = await call('mxpage_export_page', { project_id: projectId, format: 'json' })
    assert.equal(exported.ok, true)
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})

test('end-to-end: a second generation creates v2 and never overwrites v1', async () => {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-e2e2-'))
  const server = await startMockServer()
  try {
    const h = buildHarness(store, server.baseUrl)
    const project = await h.host.repository.project.create({
      name: 'e2e2',
      platform: 'taobao_tmall',
      style: 'premium',
    })
    await h.assets.saveUploadAsset({
      projectId: project.id,
      type: 'MAIN',
      fileName: 'main.png',
      mimeType: 'image/png',
      fileBuffer: Buffer.from(TINY_PNG_B64, 'base64'),
      sortOrder: 0,
      isMain: true,
    })
    await h.analysis.analyzeProject(project.id)
    const plan = await h.planner.planSections(project.id, {
      previewConfig: {
        heroImageCount: 1,
        detailSectionCount: 1,
        imageAspectRatio: '3:4',
        contentLanguage: 'zh-CN' as never,
      },
    })
    const hero = plan.sections.find((section) => section.type === 'HERO')
    assert.ok(hero)

    const first = await h.generation.generateSectionImage(project.id, hero.id)
    const second = await h.generation.regenerateSectionImage(project.id, hero.id)

    assert.notEqual(first.imageAsset.filePath, second.imageAsset.filePath)
    assert.equal(second.version.versionNumber, 2)

    const versions = await h.generation.listSectionVersions(hero.id)
    assert.equal(versions.length, 2)
    assert.deepEqual(
      versions.map((version) => version.isActive).sort(),
      [false, true],
      'exactly one active version',
    )

    const dir = join(store, 'generated', project.id, hero.id)
    assert.equal(readdirSync(dir).length, 2, 'both versions stay on disk')

    // Activating v1 must repoint the section without deleting v2.
    const activated = await h.generation.activateSectionVersion(hero.id, first.version.id)
    assert.equal(activated?.id, first.version.id)
    assert.equal(
      (await h.host.repository.section.get(hero.id))?.currentImageAssetId,
      first.imageAsset.id,
    )
    assert.equal(readdirSync(dir).length, 2)
  } finally {
    await server.close()
    rmSync(store, { recursive: true, force: true })
  }
})
