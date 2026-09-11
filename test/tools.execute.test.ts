import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Config } from '../src/config.ts'
import type { ImagesClient } from '../src/provider/openai-images.ts'
import { registerMxpageTools } from '../src/tools/register.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

type SavedImage = { data: Uint8Array; mediaType: string; name?: string }
type ToolDef = {
  name: string
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
  output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }> }
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

function fakeExec(signal?: AbortSignal) {
  return { signal: signal ?? new AbortController().signal }
}

function setup(
  t: TestContext,
  opts: { images?: ImagesClient } = {},
) {
  const tmp = mkdtempSync(join(tmpdir(), 'mxpage-tools-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const saved: SavedImage[] = []
  const tools: ToolDef[] = []
  const ctx = {
    tools: { register(tool: ToolDef) { tools.push(tool) } },
    attachments: {
      saveImage: async (input: SavedImage) => {
        saved.push(input)
        return {
          attachmentId: 'att_1',
          mediaType: 'image/png' as const,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
        }
      },
    },
    jobs: {
      start() { throw new Error('jobs unused in P1') },
      kill() { return 'already-finished' as const },
      get(id: string) { return { id, status: 'failed' } },
    },
  }
  const fixture = join(tmp, 'fixture.png')
  writeFileSync(fixture, PNG)
  registerMxpageTools(ctx as never, testConfig(tmp), opts.images ? { images: opts.images } : undefined)
  const byName = (name: string) => {
    const found = tools.find((tool) => tool.name === name)
    assert.ok(found, `missing tool ${name}`)
    return found
  }
  return { tmp, saved, tools, fixture, byName }
}

test('registers the mxpage_* tools and never generate_image', (t) => {
  const { tools } = setup(t, {
    images: {
      generate: async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }),
      edit: async () => { throw new Error('unused') },
    },
  })
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'mxpage_add_asset',
      'mxpage_analyze_product',
      'mxpage_create_project',
      'mxpage_edit_section',
      'mxpage_export_page',
      'mxpage_generate_page',
      'mxpage_generate_section',
      'mxpage_job_cancel',
      'mxpage_job_status',
      'mxpage_plan_page',
      'mxpage_project_status',
      'mxpage_refine_prompt',
    ],
  )
  assert.ok(!tools.some((tool) => /generate_image|image_generate/i.test(tool.name)))
  const generate = tools.find((tool) => tool.name === 'mxpage_generate_section')!
  assert.equal(generate.timeoutMs, 180_000)
  assert.equal(generate.isConcurrencySafe?.({}), false)
})

test('create_project copies fixture PNG into assets/ and does not delete source', async (t) => {
  const { fixture, byName } = setup(t)
  const create = byName('mxpage_create_project')
  const result = await create.execute({ image_paths: [fixture] }, fakeExec()) as {
    ok: boolean
    projectId: string
    assetCount: number
    mainAssetPath: string
    workspaceDir: string
  }
  assert.equal(result.ok, true)
  assert.ok(existsSync(fixture), 'source still exists after create')
  assert.ok(readFileSync(fixture).equals(PNG))
  const dest = join(result.workspaceDir, 'assets', basename(fixture))
  assert.equal(result.mainAssetPath, dest)
  assert.ok(existsSync(dest))
  assert.ok(readFileSync(dest).equals(PNG))
  assert.equal(result.assetCount, 1)
  assert.match(result.projectId, /^mxp_/)
})

test('generate_section with mock client writes png and calls saveImage', async (t) => {
  const calls: unknown[] = []
  const images: ImagesClient = {
    generate: async (input) => {
      calls.push(input)
      return { bytes: new Uint8Array(PNG), mediaType: 'image/png' }
    },
    edit: async () => { throw new Error('unused') },
  }
  const { fixture, saved, byName } = setup(t, { images })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture], name: 'bottle' },
    fakeExec(),
  ) as { ok: true; projectId: string; workspaceDir: string }

  const result = await byName('mxpage_generate_section').execute(
    {
      project_id: created.projectId,
      section_key: 'hero_01',
      prompt_override: '只要一张白底主图，1:1',
    },
    fakeExec(),
  ) as {
    ok: boolean
    projectId: string
    sectionKey: string
    outputPath: string
    attachmentId: string
    modelUsed: string
    versionId: string
  }

  assert.equal(result.ok, true)
  assert.equal(result.projectId, created.projectId)
  assert.equal(result.sectionKey, 'hero_01')
  assert.equal(result.attachmentId, 'att_1')
  assert.equal(result.modelUsed, 'gpt-image-2')
  assert.equal(result.versionId, 'v1')
  assert.ok(existsSync(result.outputPath))
  assert.ok(readFileSync(result.outputPath).equals(PNG))
  assert.equal(result.outputPath, join(created.workspaceDir, 'output', 'hero_01.png'))
  assert.ok(existsSync(join(created.workspaceDir, 'versions', 'hero_01', 'v1.png')))
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.mediaType, 'image/png')
  assert.equal(saved[0]?.name, 'hero_01.png')
  assert.ok(Buffer.from(saved[0]!.data).equals(PNG))
  assert.equal(calls.length, 1)
  const call = calls[0] as { prompt: string; references: unknown[]; size: string; model: string }
  assert.equal(call.prompt, '只要一张白底主图，1:1')
  assert.equal(call.model, 'gpt-image-2')
  assert.equal(call.size, '1024x1024')
  assert.ok(call.references.length >= 1, 'default references include the main asset')
})

test('generate_section render output is text-only with no image / base64', async (t) => {
  const { byName } = setup(t, {
    images: {
      generate: async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }),
      edit: async () => { throw new Error('unused') },
    },
  })
  const generate = byName('mxpage_generate_section')
  const value = {
    ok: true,
    projectId: 'mxp_test',
    sectionKey: 'hero_01',
    outputPath: '/tmp/hero_01.png',
    attachmentId: 'att_1',
    modelUsed: 'gpt-image-2',
    versionId: 'v1',
  }
  const blocks = generate.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'text')
  assert.equal(blocks[0]?.text, JSON.stringify(value, null, 2))
  assert.ok(!blocks.some((block) => block.type === 'image'))
  assert.doesNotMatch(JSON.stringify(blocks), /base64/i)
  assert.doesNotMatch(blocks[0]?.text ?? '', /iVBORw0KGgo/)
})

test('../etc/passwd as image_paths throws', async (t) => {
  const { byName } = setup(t)
  await assert.rejects(
    () => byName('mxpage_create_project').execute({ image_paths: ['../etc/passwd'] }, fakeExec()),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /path escapes project root/)
      return true
    },
  )
})

test('exec.signal abort stops generate', async (t) => {
  let release: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    release = resolve
  })
  const images: ImagesClient = {
    generate: async (input) => {
      release?.()
      await new Promise<never>((_, reject) => {
        const fail = () => reject(new Error('已取消'))
        if (input.signal.aborted) {
          fail()
          return
        }
        input.signal.addEventListener('abort', fail, { once: true })
      })
    },
    edit: async () => { throw new Error('unused') },
  }
  const { fixture, byName, saved } = setup(t, { images })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string; workspaceDir: string }

  const ac = new AbortController()
  const pending = byName('mxpage_generate_section').execute(
    {
      project_id: created.projectId,
      section_key: 'hero_01',
      prompt_override: 'white bg',
    },
    fakeExec(ac.signal),
  )
  await started
  ac.abort()
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof Error)
    assert.match(err.message, /已取消/)
    return true
  })
  assert.equal(saved.length, 0)
  assert.equal(existsSync(join(created.workspaceDir, 'output', 'hero_01.png')), false)
})

test('generate_section without prompt_override or prompt file returns missing prompt', async (t) => {
  const { fixture, byName } = setup(t, {
    images: {
      generate: async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }),
      edit: async () => { throw new Error('unused') },
    },
  })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string }
  const result = await byName('mxpage_generate_section').execute(
    { project_id: created.projectId, section_key: 'hero_01' },
    fakeExec(),
  )
  assert.deepEqual(result, {
    ok: false,
    error: 'missing prompt; call mxpage_refine_prompt or pass prompt_override',
  })
})

test('generate_section without API key returns ok:false and does not throw a stack', async (t) => {
  const prev = process.env.MXPAGE_IMAGE_API_KEY
  delete process.env.MXPAGE_IMAGE_API_KEY
  t.after(() => {
    if (prev === undefined) delete process.env.MXPAGE_IMAGE_API_KEY
    else process.env.MXPAGE_IMAGE_API_KEY = prev
  })
  const { fixture, byName } = setup(t)
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string }
  const result = await byName('mxpage_generate_section').execute(
    {
      project_id: created.projectId,
      section_key: 'hero_01',
      prompt_override: 'white bg',
    },
    fakeExec(),
  )
  assert.deepEqual(result, {
    ok: false,
    error: '未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）',
  })
})

test('add_asset requires image_path; attachment_id-only is refused in P1', async (t) => {
  const { fixture, byName } = setup(t)
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string; assetCount: number; mainAssetPath: string }

  const neither = await byName('mxpage_add_asset').execute(
    { project_id: created.projectId, role: 'angle' },
    fakeExec(),
  ) as { ok: false; error: string }
  assert.equal(neither.ok, false)
  assert.match(neither.error, /image_path/)

  const attachmentOnly = await byName('mxpage_add_asset').execute(
    { project_id: created.projectId, role: 'angle', attachment_id: 'att_x' },
    fakeExec(),
  )
  assert.deepEqual(attachmentOnly, {
    ok: false,
    error: '请提供 image_path（P1 暂不从附件读取）',
  })

  const extra = join(fixture, '..', 'angle.png')
  writeFileSync(extra, PNG)
  const added = await byName('mxpage_add_asset').execute(
    { project_id: created.projectId, role: 'angle', image_path: extra },
    fakeExec(),
  ) as { ok: true; projectId: string; assetCount: number; mainAssetPath: string }
  assert.equal(added.ok, true)
  assert.equal(added.assetCount, 2)
  assert.equal(added.mainAssetPath, created.mainAssetPath)
})

test('project_status is readable before analyze and lists generated sections', async (t) => {
  const { fixture, byName } = setup(t, {
    images: {
      generate: async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }),
      edit: async () => { throw new Error('unused') },
    },
  })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture], language: 'zh-CN', aspect_ratio: '1:1' },
    fakeExec(),
  ) as { ok: true; projectId: string; mainAssetPath: string }

  const before = await byName('mxpage_project_status').execute(
    { project_id: created.projectId },
    fakeExec(),
  ) as {
    ok: boolean
    status: string
    language: string
    aspectRatio: string
    mainAssetPath: string
    assets: unknown[]
    sections: unknown[]
  }
  assert.equal(before.ok, true)
  assert.equal(before.status, 'created')
  assert.equal(before.language, 'zh-CN')
  assert.equal(before.aspectRatio, '1:1')
  assert.equal(before.mainAssetPath, created.mainAssetPath)
  assert.equal(before.assets.length, 1)
  assert.deepEqual(before.sections, [])

  await byName('mxpage_generate_section').execute(
    {
      project_id: created.projectId,
      section_key: 'hero_01',
      prompt_override: 'white bg',
    },
    fakeExec(),
  )
  const after = await byName('mxpage_project_status').execute(
    { project_id: created.projectId },
    fakeExec(),
  ) as { sections: Array<{ key: string; outputPath?: string; versionId?: string }> }
  assert.equal(after.sections.length, 1)
  assert.equal(after.sections[0]?.key, 'hero_01')
  assert.equal(after.sections[0]?.versionId, 'v1')
})
