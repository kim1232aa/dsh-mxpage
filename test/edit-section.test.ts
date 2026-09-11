import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Config } from '../src/config.ts'
import type { ImageBlob, ImagesClient } from '../src/provider/openai-images.ts'
import { registerMxpageTools } from '../src/tools/register.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_EDIT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

type SavedImage = { data: Uint8Array; mediaType: string; name?: string }
type ToolDef = {
  name: string
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<unknown>
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

function setup(t: TestContext, opts: { images?: ImagesClient; injectImages?: boolean } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'mxpage-edit-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const saved: SavedImage[] = []
  const tools: ToolDef[] = []
  const ctx = {
    tools: { register(tool: ToolDef) { tools.push(tool) } },
    attachments: {
      saveImage: async (input: SavedImage) => {
        saved.push(input)
        return { attachmentId: `att_${saved.length}`, mediaType: 'image/png' as const }
      },
    },
    jobs: {
      start() { throw new Error('jobs unused in edit tests') },
      kill() { return 'already-finished' as const },
      get(id: string) { return { id, status: 'failed' } },
    },
  }
  const fixture = join(tmp, 'fixture.png')
  writeFileSync(fixture, PNG)
  registerMxpageTools(ctx as never, testConfig(tmp), {
    ...(opts.injectImages === false ? {} : opts.images ? { images: opts.images } : {}),
  })
  const byName = (name: string) => {
    const found = tools.find((tool) => tool.name === name)
    assert.ok(found, `missing tool ${name}`)
    return found
  }
  return { tmp, saved, tools, fixture, byName }
}

test('translate without target_language returns MXPAGE_MISSING_LANGUAGE', async (t) => {
  const images: ImagesClient = {
    generate: async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }),
    edit: async () => { throw new Error('unused') },
  }
  const { fixture, byName } = setup(t, { images })
  const edit = byName('mxpage_edit_section')
  assert.equal(edit.isConcurrencySafe?.({}), false)
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string }
  const result = await edit.execute(
    { project_id: created.projectId, section_key: 'hero_01', mode: 'translate' },
    fakeExec(),
  ) as { ok: false; error: string }
  assert.equal(result.ok, false)
  assert.match(result.error, /MXPAGE_MISSING_LANGUAGE/)
})

test('edit writes versions/<key>/v2.png and leaves v1.png', async (t) => {
  const editCalls: Array<{ prompt: string; image: ImageBlob; references: ImageBlob[]; size: string }> = []
  const images: ImagesClient = {
    generate: async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }),
    edit: async (input) => {
      editCalls.push({
        prompt: input.prompt,
        image: input.image,
        references: input.references,
        size: input.size,
      })
      return { bytes: new Uint8Array(PNG_EDIT), mediaType: 'image/png' }
    },
  }
  const { fixture, saved, byName } = setup(t, { images })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string; workspaceDir: string }
  const generated = await byName('mxpage_generate_section').execute(
    {
      project_id: created.projectId,
      section_key: 'hero_01',
      prompt_override: '只要一张白底主图，1:1',
    },
    fakeExec(),
  ) as { ok: true; versionId: string }
  assert.equal(generated.ok, true)
  assert.equal(generated.versionId, 'v1')
  const v1 = join(created.workspaceDir, 'versions', 'hero_01', 'v1.png')
  const v2 = join(created.workspaceDir, 'versions', 'hero_01', 'v2.png')
  const output = join(created.workspaceDir, 'output', 'hero_01.png')
  assert.ok(existsSync(v1))
  assert.ok(readFileSync(v1).equals(PNG))

  const edited = await byName('mxpage_edit_section').execute(
    {
      project_id: created.projectId,
      section_key: 'hero_01',
      mode: 'repaint',
      instruction: '换成暖色棚拍光',
    },
    fakeExec(),
  ) as { ok: boolean; versionId: string; outputPath: string }
  assert.equal(edited.ok, true)
  assert.equal(edited.versionId, 'v2')
  assert.ok(existsSync(v1), 'v1 must remain')
  assert.ok(readFileSync(v1).equals(PNG), 'v1 bytes unchanged')
  assert.ok(existsSync(v2))
  assert.ok(readFileSync(v2).equals(PNG_EDIT))
  assert.ok(existsSync(output))
  assert.ok(readFileSync(output).equals(PNG_EDIT))
  assert.equal(editCalls.length, 1)
  assert.equal(editCalls[0]?.size, '1024x1024')
  assert.ok(editCalls[0]!.references.length >= 1)
  assert.ok(saved.some((item) => Buffer.from(item.data).equals(PNG_EDIT)))

  const blocks = byName('mxpage_edit_section').output.render({}, edited)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'text')
  assert.ok(!blocks.some((block) => block.type === 'image'))
})

test('edit without current output returns MXPAGE_NOT_FOUND', async (t) => {
  const images: ImagesClient = {
    generate: async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }),
    edit: async () => { throw new Error('unused') },
  }
  const { fixture, byName } = setup(t, { images })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string }
  const result = await byName('mxpage_edit_section').execute(
    {
      project_id: created.projectId,
      section_key: 'hero_01',
      mode: 'enhance',
      instruction: '更清晰',
    },
    fakeExec(),
  ) as { ok: false; error: string }
  assert.equal(result.ok, false)
  assert.match(result.error, /MXPAGE_NOT_FOUND/)
})

test('edit_section without image key returns ok:false', async (t) => {
  const prev = process.env.MXPAGE_IMAGE_API_KEY
  delete process.env.MXPAGE_IMAGE_API_KEY
  t.after(() => {
    if (prev === undefined) delete process.env.MXPAGE_IMAGE_API_KEY
    else process.env.MXPAGE_IMAGE_API_KEY = prev
  })
  const { fixture, byName } = setup(t, { injectImages: false })
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string }
  const result = await byName('mxpage_edit_section').execute(
    {
      project_id: created.projectId,
      section_key: 'hero_01',
      mode: 'repaint',
      instruction: '换背景',
    },
    fakeExec(),
  )
  assert.deepEqual(result, {
    ok: false,
    error: '未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）',
  })
})
