import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Config } from '../src/config.ts'
import type { CompleteJson } from '../src/provider/vision-text.ts'
import { registerMxpageTools } from '../src/tools/register.ts'
import { VALID_ANALYSIS } from './fixtures.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

type ToolDef = {
  name: string
  timeoutMs?: number
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

function fakeExec() {
  return { signal: new AbortController().signal }
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

function setup(t: TestContext, completeJson?: CompleteJson) {
  const tmp = mkdtempSync(join(tmpdir(), 'mxpage-p2-'))
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
  registerMxpageTools(ctx as never, testConfig(tmp), completeJson ? { completeJson } : undefined)
  const byName = (name: string) => {
    const found = tools.find((tool) => tool.name === name)
    assert.ok(found, `missing tool ${name}`)
    return found
  }
  return { tmp, fixture, tools, byName }
}

test('analyze without vision caller returns Chinese error and does not throw', async (t) => {
  const { fixture, byName } = setup(t)
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string }
  const result = await byName('mxpage_analyze_product').execute(
    { project_id: created.projectId },
    fakeExec(),
  )
  assert.deepEqual(result, {
    ok: false,
    error: '当前模型不支持视觉，无法分析商品图',
  })
})

test('analyze writes analysis.json and transitions to analyzed', async (t) => {
  const completeJson: CompleteJson = async () => ({
    ok: true,
    text: JSON.stringify(VALID_ANALYSIS),
    modelUsed: 'mock-vision',
  })
  const { fixture, byName } = setup(t, completeJson)
  assert.equal(byName('mxpage_analyze_product').timeoutMs, 120_000)
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string; workspaceDir: string }
  const result = await byName('mxpage_analyze_product').execute(
    { project_id: created.projectId },
    fakeExec(),
  ) as { ok: boolean; projectId: string; modelUsed: string; analysis: { productName: string } }
  assert.equal(result.ok, true)
  assert.equal(result.projectId, created.projectId)
  assert.equal(result.modelUsed, 'mock-vision')
  assert.equal(result.analysis.productName, '三阶磁力魔方')
  const analysisFile = join(created.workspaceDir, 'analysis.json')
  assert.ok(existsSync(analysisFile))
  assert.equal(JSON.parse(readFileSync(analysisFile, 'utf8')).productName, '三阶磁力魔方')
  const status = await byName('mxpage_project_status').execute(
    { project_id: created.projectId },
    fakeExec(),
  ) as { status: string }
  assert.equal(status.status, 'analyzed')
})

test('analyze repairs invalid JSON once then succeeds', async (t) => {
  let calls = 0
  const completeJson: CompleteJson = async () => {
    calls += 1
    if (calls === 1) return { ok: true, text: 'not-json', modelUsed: 'mock-vision' }
    return { ok: true, text: JSON.stringify(VALID_ANALYSIS), modelUsed: 'mock-vision' }
  }
  const { fixture, byName } = setup(t, completeJson)
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string }
  const result = await byName('mxpage_analyze_product').execute(
    { project_id: created.projectId },
    fakeExec(),
  ) as { ok: boolean }
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
})

test('plan writes plan.json and style-guide.json', async (t) => {
  const completeJson: CompleteJson = async ({ user }) => {
    if (user.includes('product strategist') || user.includes('malformed product-analysis')) {
      return { ok: true, text: JSON.stringify(VALID_ANALYSIS), modelUsed: 'mock-vision' }
    }
    return { ok: true, text: JSON.stringify(validPlan(3, 6)), modelUsed: 'mock-text' }
  }
  const { fixture, byName } = setup(t, completeJson)
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string; workspaceDir: string }
  await byName('mxpage_analyze_product').execute({ project_id: created.projectId }, fakeExec())
  const planned = await byName('mxpage_plan_page').execute(
    { project_id: created.projectId },
    fakeExec(),
  ) as {
    ok: boolean
    visualStyleGuide: { styleName: string }
    sections: Array<{ sectionKey?: string; type: string }>
    previewConfig: { heroImageCount: number; detailSectionCount: number }
  }
  assert.equal(planned.ok, true)
  assert.equal(planned.visualStyleGuide.styleName, '清爽电商')
  assert.equal(planned.previewConfig.heroImageCount, 3)
  assert.equal(planned.previewConfig.detailSectionCount, 6)
  assert.ok(planned.sections.length >= 9)
  assert.ok(existsSync(join(created.workspaceDir, 'plan.json')))
  assert.ok(existsSync(join(created.workspaceDir, 'style-guide.json')))
  const status = await byName('mxpage_project_status').execute(
    { project_id: created.projectId },
    fakeExec(),
  ) as { status: string }
  assert.equal(status.status, 'planned')
})

test('refine_prompt writes VPA json under prompts/', async (t) => {
  const vpa = {
    analysisSummary: '主视觉强调磁力结构',
    finalPrompt: 'Square e-commerce hero of the 3x3 speed cube, main subject matches reference.',
    negativePrompt: 'garbled text, reversed geometry',
    qualityChecklist: ['主体与参考图一致', '避免乱码文字'],
  }
  const completeJson: CompleteJson = async ({ user }) => {
    if (user.includes('Visual Prompt Agent') || user.includes('finalPrompt')) {
      return { ok: true, text: JSON.stringify(vpa), modelUsed: 'mock-vpa' }
    }
    if (user.includes('product strategist') || user.includes('malformed product-analysis')) {
      return { ok: true, text: JSON.stringify(VALID_ANALYSIS), modelUsed: 'mock-vision' }
    }
    return { ok: true, text: JSON.stringify(validPlan(3, 6)), modelUsed: 'mock-text' }
  }
  const { fixture, byName } = setup(t, completeJson)
  const created = await byName('mxpage_create_project').execute(
    { image_paths: [fixture] },
    fakeExec(),
  ) as { ok: true; projectId: string; workspaceDir: string }
  await byName('mxpage_analyze_product').execute({ project_id: created.projectId }, fakeExec())
  await byName('mxpage_plan_page').execute({ project_id: created.projectId }, fakeExec())
  const refined = await byName('mxpage_refine_prompt').execute(
    { project_id: created.projectId, section_key: 'hero_01' },
    fakeExec(),
  ) as { ok: boolean; finalPrompt: string; negativePrompt: string }
  assert.equal(refined.ok, true)
  assert.equal(refined.finalPrompt, vpa.finalPrompt)
  const file = join(created.workspaceDir, 'prompts', 'hero_01.json')
  assert.ok(existsSync(file))
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).finalPrompt, vpa.finalPrompt)
})

test('analyze/plan/refine render is text-only', (t) => {
  const { byName } = setup(t)
  for (const name of ['mxpage_analyze_product', 'mxpage_plan_page', 'mxpage_refine_prompt']) {
    const blocks = byName(name).output.render({}, { ok: true })
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]?.type, 'text')
  }
})
