import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Config } from '../src/config.ts'
import { assertTransition, type STATUS } from '../src/service/state-machine.ts'
import { registerMxpageTools } from '../src/tools/register.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

type ToolDef = {
  name: string
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
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

function setup(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), 'mxpage-plan-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const tools: ToolDef[] = []
  const ctx = {
    tools: { register(tool: ToolDef) { tools.push(tool) } },
    attachments: {
      saveImage: async () => ({ attachmentId: 'att_1' }),
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
  return { tmp, fixture, byName }
}

test('plan before analyze returns MXPAGE_STATE', async (t) => {
  const { fixture, byName } = setup(t)
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    { signal: new AbortController().signal },
  ) as { ok: true; projectId: string }
  const planned = await byName('mxpage_plan_page').execute(
    { project_id: created.projectId },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(planned, { ok: false, error: 'MXPAGE_STATE' })
})

test('created → analyzing → analyzed allowed', () => {
  let s = 'created' as STATUS
  s = assertTransition(s, 'analyzing')
  s = assertTransition(s, 'analyzed')
  assert.equal(s, 'analyzed')
})

test('analyzed|planned → planning → planned allowed for plan/replan', () => {
  let s = 'analyzed' as STATUS
  s = assertTransition(s, 'planning')
  s = assertTransition(s, 'planned')
  s = assertTransition(s, 'planning')
  s = assertTransition(s, 'planned')
  assert.equal(s, 'planned')
})
