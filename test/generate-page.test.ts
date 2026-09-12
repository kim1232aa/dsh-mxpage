import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Config } from '../src/config.ts'
import type { ImageBlob, ImagesClient } from '../src/provider/openai-images.ts'
import type { CompleteJson } from '../src/provider/vision-text.ts'
import { registerMxpageTools } from '../src/tools/register.ts'
import { VALID_ANALYSIS } from './fixtures.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

type SavedImage = { data: Uint8Array; mediaType: string; name?: string }
type JobOutcome = { status: 'completed' | 'killed' | 'failed'; detail?: string }
type JobHooks = { cancel: (reason?: string) => void; done: Promise<JobOutcome> }
type JobRecord = {
  id: string
  kind: string
  label: string
  owner?: unknown
  hooks: JobHooks
  status: string
  detail?: string
}
type ToolDef = {
  name: string
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<unknown>
  output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string; attachment?: { attachmentId?: string } }> }
}

function testConfig(workspaceDir: string): Config {
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
    workspaceDir,
  }
}

function fakeExec(signal?: AbortSignal, agent?: unknown) {
  return { signal: signal ?? new AbortController().signal, ...(agent ? { agent } : {}) }
}

function validPlan(heroCount: number, detailCount: number) {
  const heroes = Array.from({ length: heroCount }, (_, i) => ({
    id: `hero_${String(i + 1).padStart(2, '0')}`,
    type: 'hero',
    title: `头图${i + 1}`,
    goal: '建立记忆点',
    copy: '核心卖点',
    visualPrompt: 'Primary Prompt: 商品居中展示磁力结构\nEnglish Prompt: cube hero',
    editableFields: { styleRole: 'hero' },
  }))
  const details = Array.from({ length: detailCount }, (_, i) => ({
    id: `detail_${String(i + 1).padStart(2, '0')}_selling_points`,
    type: i === 0 ? 'selling_points' : 'detail_closeup',
    title: `详情${i + 1}`,
    goal: '讲清卖点',
    copy: '细节说明',
    visualPrompt: 'Primary Prompt: 细节特写\nEnglish Prompt: closeup',
    editableFields: { styleRole: 'detail' },
  }))
  return {
    visualStyleGuide: {
      styleName: '清爽电商',
      colorPalette: '白+六色',
      backgroundSystem: '浅底',
      lighting: '柔光',
      cameraLanguage: '3/4',
      typography: '无衬线',
      layoutRules: '中等密度',
      propRules: '少道具',
      productRenderingRules: '保持魔方结构',
      negativeStyleConstraints: '禁止逆风、乱码',
    },
    sections: [...heroes, ...details],
  }
}

const VPA = {
  analysisSummary: '主视觉强调磁力结构',
  finalPrompt: 'Square e-commerce hero of the 3x3 speed cube, main subject matches reference.',
  negativePrompt: 'garbled text, reversed geometry',
  qualityChecklist: ['主体与参考图一致', '避免乱码文字'],
}

function pageCompleteJson(): CompleteJson {
  return async ({ user }) => {
    if (user.includes('Visual Prompt Agent') || user.includes('finalPrompt')) {
      return { ok: true, text: JSON.stringify(VPA), modelUsed: 'mock-vpa' }
    }
    if (user.includes('product strategist') || user.includes('malformed product-analysis')) {
      return { ok: true, text: JSON.stringify(VALID_ANALYSIS), modelUsed: 'mock-vision' }
    }
    return { ok: true, text: JSON.stringify(validPlan(1, 3)), modelUsed: 'mock-text' }
  }
}

function createJobs(opts: { throwBeforeRun?: Error } = {}) {
  const records = new Map<string, JobRecord>()
  let n = 0
  let startCalls = 0
  return {
    records,
    get startCalls() {
      return startCalls
    },
    api: {
      start(spec: {
        kind: string
        label: string
        owner?: unknown
        run: () => JobHooks
      }) {
        startCalls += 1
        if (opts.throwBeforeRun) throw opts.throwBeforeRun
        const hooks = spec.run()
        const id = `mxpage_page-${++n}`
        const rec: JobRecord = {
          id,
          kind: spec.kind,
          label: spec.label,
          owner: spec.owner,
          hooks,
          status: 'running',
        }
        records.set(id, rec)
        void hooks.done.then((outcome) => {
          rec.status = outcome.status
          rec.detail = outcome.detail
        })
        return id
      },
      kill(id: string, _caller?: unknown, reason?: string) {
        const rec = records.get(id)
        if (!rec) return 'already-finished' as const
        if (rec.status !== 'running' && rec.status !== 'stopping') return 'already-finished' as const
        rec.status = 'stopping'
        rec.hooks.cancel(reason)
        return 'requested' as const
      },
      get(id: string, _caller?: unknown) {
        const rec = records.get(id)
        if (!rec) throw new Error(`unknown job ${id}`)
        return { id: rec.id, status: rec.status, detail: rec.detail }
      },
    },
  }
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 15))
  }
}

function setup(
  t: TestContext,
  opts: {
    images?: ImagesClient
    completeJson?: CompleteJson
    injectImages?: boolean
    throwBeforeRun?: Error
  } = {},
) {
  const tmp = mkdtempSync(join(tmpdir(), 'mxpage-page-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const saved: SavedImage[] = []
  const tools: ToolDef[] = []
  const jobs = createJobs({ throwBeforeRun: opts.throwBeforeRun })
  const ctx = {
    tools: { register(tool: ToolDef) { tools.push(tool) } },
    attachments: {
      saveImage: async (input: SavedImage) => {
        saved.push(input)
        return {
          attachmentId: `att_${saved.length}`,
          mediaType: 'image/png' as const,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
          name: input.name,
        }
      },
    },
    jobs: jobs.api,
  }
  const fixture = join(tmp, 'fixture.png')
  writeFileSync(fixture, PNG)
  const injectImages = opts.injectImages ?? true
  registerMxpageTools(ctx as never, testConfig(tmp), {
    ...(opts.completeJson ? { completeJson: opts.completeJson } : {}),
    ...(injectImages && opts.images ? { images: opts.images } : {}),
  })
  const byName = (name: string) => {
    const found = tools.find((tool) => tool.name === name)
    assert.ok(found, `missing tool ${name}`)
    return found
  }
  return { tmp, saved, tools, fixture, byName, jobs }
}

test('unanalyzed generate_page job analyzes, plans, and writes ≥1 hero + ≥3 details', async (t) => {
  const generateCalls: Array<{ prompt: string; references: ImageBlob[]; size: string; model: string }> = []
  const images: ImagesClient = {
    generate: async (input) => {
      generateCalls.push({
        prompt: input.prompt,
        references: input.references,
        size: input.size,
        model: input.model,
      })
      return { bytes: new Uint8Array(PNG), mediaType: 'image/png' }
    },
    edit: async () => { throw new Error('unused') },
  }
  const { fixture, saved, byName, jobs } = setup(t, { images, completeJson: pageCompleteJson() })
  const page = byName('mxpage_generate_page')
  assert.equal(page.timeoutMs, 180_000)
  assert.equal(page.isConcurrencySafe?.({}), false)

  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture], name: 'cube' },
    fakeExec(),
  ) as { ok: true; projectId: string; workspaceDir: string; mainAssetPath: string }
  assert.equal(created.ok, true)

  const finished = await page.execute(
    { project_id: created.projectId },
    fakeExec(),
  ) as { ok: boolean; jobId: string; state: string; outputs: unknown[] }
  assert.equal(finished.ok, true)
  assert.equal(finished.state, 'completed')
  assert.ok(finished.jobId)
  const rec = jobs.records.get(finished.jobId)
  assert.ok(rec, 'job was registered')
  assert.equal(rec.kind, 'mxpage_page')
  assert.equal(rec.label, `mxpage page ${created.projectId}`)
  const outcome = await rec.hooks.done
  assert.equal(outcome.status, 'completed')

  const outputDir = join(created.workspaceDir, 'output')
  const names = existsSync(outputDir) ? readdirSync(outputDir).filter((n) => n.endsWith('.png')) : []
  const heroes = names.filter((n) => n.startsWith('hero_'))
  const details = names.filter((n) => n.startsWith('detail_'))
  assert.ok(heroes.length >= 1, `expected ≥1 hero, got ${heroes.join(',')}`)
  assert.ok(details.length >= 3, `expected ≥3 details, got ${details.join(',')}`)
  assert.ok(saved.length >= 4, `saveImage called ${saved.length} times`)
  assert.ok(existsSync(join(created.workspaceDir, 'analysis.json')))
  assert.ok(existsSync(join(created.workspaceDir, 'plan.json')))

  const status = await byName('mxpage_job_status').execute(
    { job_id: finished.jobId },
    fakeExec(),
  ) as { ok: boolean; state: string; progress: number }
  assert.equal(status.ok, true)
  assert.equal(status.state, 'completed')
  assert.equal(status.progress, 1)

  const blocks = page.output.render({}, finished)
  assert.equal(blocks[0]?.type, 'text')
  assert.ok(blocks.some((block) => block.type === 'image'), 'page result must render image attachments')
  assert.doesNotMatch(JSON.stringify(blocks), /base64/i)
  assert.ok(Array.isArray(finished.outputs) && finished.outputs.length >= 4)
})

test('detail generate references include main product image and first hero output', async (t) => {
  const generateCalls: Array<{ references: ImageBlob[] }> = []
  const images: ImagesClient = {
    generate: async (input) => {
      generateCalls.push({ references: input.references })
      return { bytes: new Uint8Array(PNG), mediaType: 'image/png' }
    },
    edit: async () => { throw new Error('unused') },
  }
  const { fixture, byName, jobs } = setup(t, { images, completeJson: pageCompleteJson() })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string; mainAssetPath: string }
  const started = await byName('mxpage_generate_page').execute(
    { project_id: created.projectId },
    fakeExec(),
  ) as { ok: true; jobId: string; state: string }
  assert.equal(started.ok, true)
  assert.equal(started.state, 'completed')

  const mainName = basename(created.mainAssetPath)
  const detailCalls = generateCalls.filter((call) => {
    const names = call.references.map((ref) => ref.filename)
    return names.some((name) => /^hero_.*\.png$/i.test(name))
  })
  assert.ok(detailCalls.length >= 3, `expected detail generate calls with hero ref, got ${detailCalls.length}`)
  for (const call of detailCalls) {
    const names = call.references.map((ref) => ref.filename)
    assert.ok(names.length >= 2, `detail refs ${names.join(',')}`)
    assert.ok(names.includes(mainName), `missing main ${mainName} in ${names.join(',')}`)
    assert.ok(names.some((name) => /^hero_.*\.png$/i.test(name)), `missing hero in ${names.join(',')}`)
  }
})

test('cancel stops the page job and keeps completed section files', async (t) => {
  let calls = 0
  let releaseFirst: (() => void) | undefined
  const firstStarted = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const images: ImagesClient = {
    generate: async (input) => {
      calls += 1
      if (calls === 1) {
        releaseFirst?.()
        return { bytes: new Uint8Array(PNG), mediaType: 'image/png' }
      }
      await new Promise<never>((_, reject) => {
        const fail = () => {
          const err = new Error('已取消')
          err.name = 'AbortError'
          reject(err)
        }
        if (input.signal.aborted) {
          fail()
          return
        }
        input.signal.addEventListener('abort', fail, { once: true })
      })
      throw new Error('unreachable')
    },
    edit: async () => { throw new Error('unused') },
  }
  const { fixture, byName, jobs } = setup(t, { images, completeJson: pageCompleteJson() })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string; workspaceDir: string }
  const page = byName('mxpage_generate_page')
  const pending = page.execute(
    { project_id: created.projectId },
    fakeExec(),
  )

  await firstStarted
  const heroPath = join(created.workspaceDir, 'output', 'hero_01.png')
  await waitFor(() => existsSync(heroPath))
  assert.ok(existsSync(heroPath))

  const jobId = [...jobs.records.keys()][0]
  assert.ok(jobId)
  const cancelled = await byName('mxpage_job_cancel').execute(
    { job_id: jobId, reason: 'test' },
    fakeExec(),
  ) as { ok: boolean }
  assert.equal(cancelled.ok, true)

  const result = await pending as { ok: boolean; state: string }
  assert.equal(result.ok, false)
  assert.ok(result.state === 'killed' || result.state === 'failed', result.state)
  const rec = jobs.records.get(jobId)!
  const outcome = await rec.hooks.done
  assert.ok(outcome.status === 'killed' || outcome.status === 'failed', outcome.status)
  assert.ok(existsSync(heroPath), 'completed hero remains')
  const outputDir = join(created.workspaceDir, 'output')
  const details = existsSync(outputDir)
    ? readdirSync(outputDir).filter((n) => n.startsWith('detail_') && n.endsWith('.png'))
    : []
  assert.ok(details.length < 3, 'cancelled job must not finish the full page')
})

test('generate_page without image key does not start a job', async (t) => {
  const prev = process.env.MXPAGE_IMAGE_API_KEY
  delete process.env.MXPAGE_IMAGE_API_KEY
  t.after(() => {
    if (prev === undefined) delete process.env.MXPAGE_IMAGE_API_KEY
    else process.env.MXPAGE_IMAGE_API_KEY = prev
  })
  const { fixture, byName, jobs } = setup(t, { completeJson: pageCompleteJson(), injectImages: false })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string }
  const result = await byName('mxpage_generate_page').execute(
    { project_id: created.projectId },
    fakeExec(),
  )
  assert.deepEqual(result, {
    ok: false,
    error: '未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）',
  })
  assert.equal(jobs.startCalls, 0)
})

test('aborted exec.signal throws AbortError and does not start a job', async (t) => {
  const images: ImagesClient = {
    generate: async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }),
    edit: async () => { throw new Error('unused') },
  }
  const { fixture, byName, jobs } = setup(t, { images, completeJson: pageCompleteJson() })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string }
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    () => byName('mxpage_generate_page').execute({ project_id: created.projectId }, fakeExec(ac.signal)),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.name, 'AbortError')
      assert.match(err.message, /已取消/)
      return true
    },
  )
  assert.equal(jobs.startCalls, 0)
})

test('jobs.start throw does not generate, write output, or leave unhandled rejection', async (t) => {
  let generateCalls = 0
  const images: ImagesClient = {
    generate: async () => {
      generateCalls += 1
      return { bytes: new Uint8Array(PNG), mediaType: 'image/png' }
    },
    edit: async () => { throw new Error('unused') },
  }
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => {
    process.off('unhandledRejection', onUnhandled)
  })

  const startError = new Error('max concurrent jobs per owner')
  const { fixture, byName, jobs } = setup(t, {
    images,
    completeJson: pageCompleteJson(),
    throwBeforeRun: startError,
  })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string; workspaceDir: string }

  await assert.rejects(
    () => byName('mxpage_generate_page').execute({ project_id: created.projectId }, fakeExec()),
    (err: unknown) => {
      assert.equal(err, startError)
      return true
    },
  )

  // Give a wrongly scheduled runPageJob time to hit images.generate / write output.
  await new Promise((r) => setTimeout(r, 250))

  assert.equal(jobs.startCalls, 1)
  assert.equal(generateCalls, 0, 'images.generate must not run when start() throws')
  const outputDir = join(created.workspaceDir, 'output')
  const pngs = existsSync(outputDir)
    ? readdirSync(outputDir).filter((n) => n.endsWith('.png'))
    : []
  assert.equal(pngs.length, 0, `unexpected output pngs: ${pngs.join(',')}`)
  const tasksDir = join(created.workspaceDir, 'tasks')
  const taskFiles = existsSync(tasksDir) ? readdirSync(tasksDir) : []
  assert.equal(taskFiles.length, 0, `unexpected task files: ${taskFiles.join(',')}`)
  assert.equal(unhandled.length, 0, `unhandled rejections: ${unhandled.map(String).join('; ')}`)
})
