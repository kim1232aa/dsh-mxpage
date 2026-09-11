import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import test, { type TestContext } from 'node:test'
import type { Config } from '../src/config.ts'
import { registerMxpageTools } from '../src/tools/register.ts'
import { VALID_ANALYSIS } from './fixtures.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

type ToolDef = {
  name: string
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
  output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }> }
}

type ExportOk = {
  ok: true
  format: string
  files: string[]
  zipPath?: string
}

type ExportFail = { ok: false; error: string }

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

function fakeExec() {
  return { signal: new AbortController().signal }
}

function setup(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), 'mxpage-export-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const tools: ToolDef[] = []
  const ctx = {
    tools: { register(tool: ToolDef) { tools.push(tool) } },
    attachments: {
      saveImage: async () => ({ attachmentId: 'att_1' }),
    },
    jobs: {
      start() { throw new Error('jobs unused in export tests') },
      kill() { return 'already-finished' as const },
      get(id: string) { return { id, status: 'failed' } },
    },
  }
  const fixture = join(tmp, 'fixture.png')
  writeFileSync(fixture, PNG)
  registerMxpageTools(ctx as never, testConfig(tmp))
  const byName = (name: string) => {
    const found = tools.find((tool) => tool.name === name)
    assert.ok(found, `missing tool ${name}`)
    return found
  }
  return { tmp, tools, fixture, byName }
}

async function projectWithTwoOutputs(t: TestContext) {
  const ctx = setup(t)
  const created = await ctx.byName('mxpage_create_project').execute(
    { image_paths: [ctx.fixture], name: 'export-sku' },
    fakeExec(),
  ) as { ok: true; projectId: string; workspaceDir: string }
  const outputDir = join(created.workspaceDir, 'output')
  mkdirSync(outputDir, { recursive: true })
  const hero = join(outputDir, 'hero_01.png')
  const detail = join(outputDir, 'detail_01.png')
  writeFileSync(hero, PNG)
  writeFileSync(detail, PNG)
  writeFileSync(join(created.workspaceDir, 'analysis.json'), JSON.stringify(VALID_ANALYSIS, null, 2))
  return { ...ctx, created, hero, detail }
}

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let i = 0
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8)
    const compSize = buf.readUInt32LE(i + 18)
    const uncompSize = buf.readUInt32LE(i + 22)
    const nameLen = buf.readUInt16LE(i + 26)
    const extraLen = buf.readUInt16LE(i + 28)
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8')
    const dataStart = i + 30 + nameLen + extraLen
    const compressed = buf.subarray(dataStart, dataStart + compSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(compressed)
    else if (method === 8) data = inflateRawSync(compressed)
    else throw new Error(`unsupported zip method ${method} for ${name}`)
    assert.equal(data.length, uncompSize, `zip entry ${name} size mismatch`)
    out.set(name, data)
    i = dataStart + compSize
  }
  return out
}

test('format=paths lists both fake output pngs', async (t) => {
  const { byName, created, hero, detail } = await projectWithTwoOutputs(t)
  const result = await byName('mxpage_export_page').execute(
    { project_id: created.projectId, format: 'paths' },
    fakeExec(),
  ) as ExportOk
  assert.equal(result.ok, true)
  assert.equal(result.format, 'paths')
  assert.ok(result.files.includes(hero), `files missing ${hero}: ${result.files.join(',')}`)
  assert.ok(result.files.includes(detail), `files missing ${detail}: ${result.files.join(',')}`)
  assert.equal(result.zipPath, undefined)
})

test('format=zip creates a zip containing pngs and analysis.json', async (t) => {
  const { byName, created, hero, detail } = await projectWithTwoOutputs(t)
  const result = await byName('mxpage_export_page').execute(
    { project_id: created.projectId, format: 'zip' },
    fakeExec(),
  ) as ExportOk
  assert.equal(result.ok, true)
  assert.equal(result.format, 'zip')
  assert.ok(result.zipPath, 'zipPath required')
  assert.equal(result.zipPath, join(created.workspaceDir, 'output', result.zipPath!.split('/').pop()!))
  assert.match(result.zipPath!, /\/output\/export-[\dT-]+Z\.zip$/)
  assert.ok(existsSync(result.zipPath!))
  const entries = readZipEntries(readFileSync(result.zipPath!))
  assert.ok(entries.has('hero_01.png'), `zip entries: ${[...entries.keys()].join(',')}`)
  assert.ok(entries.has('detail_01.png'), `zip entries: ${[...entries.keys()].join(',')}`)
  assert.ok(entries.has('analysis.json'), `zip entries: ${[...entries.keys()].join(',')}`)
  assert.ok(entries.get('hero_01.png')!.equals(readFileSync(hero)))
  assert.ok(entries.get('detail_01.png')!.equals(readFileSync(detail)))
  assert.equal(
    entries.get('analysis.json')!.toString('utf8'),
    readFileSync(join(created.workspaceDir, 'analysis.json'), 'utf8'),
  )
})

test('missing project returns MXPAGE_NOT_FOUND', async (t) => {
  const { byName } = setup(t)
  const result = await byName('mxpage_export_page').execute(
    { project_id: 'mxp_does_not_exist', format: 'paths' },
    fakeExec(),
  ) as ExportFail
  assert.equal(result.ok, false)
  assert.match(result.error, /MXPAGE_NOT_FOUND/)
  assert.doesNotMatch(result.error, /sk-|Bearer /)
})

test('default format is paths and empty outputs return ok with empty files', async (t) => {
  const { byName, fixture } = setup(t)
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string }
  const result = await byName('mxpage_export_page').execute(
    { project_id: created.projectId },
    fakeExec(),
  ) as ExportOk
  assert.equal(result.ok, true)
  assert.equal(result.format, 'paths')
  assert.deepEqual(result.files, [])
})

test('export render is text-only JSON', async (t) => {
  const { byName } = setup(t)
  const value = { ok: true, format: 'paths', files: ['/tmp/hero_01.png'] }
  const blocks = byName('mxpage_export_page').output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'text')
  assert.equal(blocks[0]?.text, JSON.stringify(value, null, 2))
  assert.ok(!blocks.some((block) => block.type === 'image'))
})
