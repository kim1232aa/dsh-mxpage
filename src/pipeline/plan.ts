import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import { loadProjectImages, readAnalysisFile } from './analyze.ts'
import { buildSectionPlanningPrompt, type PlanPlatform, type PromptLanguage } from '../prompts/planning.ts'
import { completeValidatedJson, NO_VISION, type CompleteJson } from '../provider/vision-text.ts'
import {
  parseSectionPlan,
  parseVisualStyleGuide,
  type PlannedSection,
  type SectionPlanOutput,
  type SectionType,
  type VisualStyleGuide,
} from '../schemas/section-plan.ts'
import type { ProjectStore } from '../service/project-store.ts'
import { assertInside } from '../util/paths.ts'
import { redactSecrets } from '../util/redact.ts'

export interface PlanArgs {
  projectId: string
  heroCount?: number
  detailCount?: number
  platform?: PlanPlatform
  language?: PromptLanguage
}

export interface NormalizedSection {
  sectionKey: string
  type: SectionType
  title: string
  goal: string
  copy: string
  visualPrompt: string
  editableFields: Record<string, unknown>
  order: number
}

export interface PreviewConfig {
  heroImageCount: number
  detailSectionCount: number
  imageAspectRatio: '3:4' | '9:16'
  contentLanguage: PromptLanguage
}

export type PlanResult =
  | {
      ok: true
      visualStyleGuide: VisualStyleGuide
      sections: NormalizedSection[]
      previewConfig: PreviewConfig
      [key: string]: unknown
    }
  | { ok: false; error: string; [key: string]: unknown }

export interface PlanDeps {
  store: ProjectStore
  config: Config
  completeJson?: CompleteJson
}

function fail(error: string): PlanResult {
  return { ok: false, error: redactSecrets(error) }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const HERO_FALLBACK: PlannedSection[] = [
  {
    id: 'hero_01',
    type: 'hero',
    title: '第一屏主视觉',
    goal: '快速建立商品记忆点，突出第一眼吸引力。',
    copy: '用一张完成度很高的主视觉图，把商品核心价值和气质一次讲清楚。',
    visualPrompt:
      'Primary Prompt: 1:1 电商首张主视觉，商品以 3/4 角度居中偏下。几何不可反转，禁止逆风，主体与参考图一致，避免乱码文字。\nEnglish Prompt: Square e-commerce primary hero. Preserve real product geometry.',
    editableFields: { tone: '高级质感', compositionHint: '居中构图' },
  },
  {
    id: 'hero_02',
    type: 'hero',
    title: '核心卖点头图',
    goal: '用一张强转化头图把最值得买的理由直接讲透。',
    copy: '把商品最强卖点直接做进画面标题和图内短句里。',
    visualPrompt:
      'Primary Prompt: 1:1 核心卖点头图，近景产品 + 功能分解标注。几何不可反转，禁止逆风，主体与参考图一致。\nEnglish Prompt: Square selling-point hero with functional annotations.',
    editableFields: { tone: '转化导向' },
  },
  {
    id: 'hero_03',
    type: 'hero',
    title: '场景氛围头图',
    goal: '让用户快速代入使用场景和生活方式气质。',
    copy: '通过场景化构图和图内标题文案，让商品与使用时刻建立关联。',
    visualPrompt:
      'Primary Prompt: 1:1 场景氛围头图，商品放入真实使用场景。主体与参考图一致，禁止逆风。\nEnglish Prompt: Square lifestyle hero in a real usage scene.',
    editableFields: { tone: '氛围感' },
  },
  {
    id: 'hero_04',
    type: 'hero',
    title: '细节信任头图',
    goal: '用品质、工艺或材质细节建立第一屏信任感。',
    copy: '通过近景细节和简洁文案，让用户第一眼感知品质感。',
    visualPrompt:
      'Primary Prompt: 电商头图，强调品质细节。避免乱码文字，主体与参考图一致。\nEnglish Prompt: Square hero focused on craftsmanship.',
    editableFields: { tone: '品质背书' },
  },
  {
    id: 'hero_05',
    type: 'hero',
    title: '差异化亮点头图',
    goal: '突出相对竞品的差异化优势。',
    copy: '围绕核心差异化特点完成最后一张头图收口。',
    visualPrompt:
      'Primary Prompt: 电商头图，突出差异化优势。几何不可反转。\nEnglish Prompt: Square hero emphasizing differentiation.',
    editableFields: { tone: '差异化强调' },
  },
]

const DETAIL_FALLBACK: PlannedSection[] = [
  {
    id: 'selling_points_01',
    type: 'selling_points',
    title: '核心卖点速览',
    goal: '让用户快速理解最值得购买的理由。',
    copy: '用图内标题、卖点短句把购买理由讲清楚。',
    visualPrompt: 'Primary Prompt: 电商卖点模块。主体与参考图一致，避免乱码文字。\nEnglish Prompt: Selling-points section.',
    editableFields: { tone: '转化导向' },
  },
  {
    id: 'detail_closeup_01',
    type: 'detail_closeup',
    title: '细节特写',
    goal: '强化材质、工艺与真实质感。',
    copy: '通过近景放大，把材质、边缘和工艺细节讲透。',
    visualPrompt: 'Primary Prompt: 电商细节特写图。几何不可反转。\nEnglish Prompt: Detail close-up.',
    editableFields: { tone: '细节说明' },
  },
  {
    id: 'scenario_01',
    type: 'scenario',
    title: '场景使用展示',
    goal: '让用户更容易代入真实使用场景。',
    copy: '把商品放进真实场景里，提升想象空间。',
    visualPrompt: 'Primary Prompt: 生活方式场景图。禁止逆风，主体与参考图一致。\nEnglish Prompt: Lifestyle usage scene.',
    editableFields: { tone: '生活方式' },
  },
  {
    id: 'specs_01',
    type: 'specs',
    title: '规格信息说明',
    goal: '把参数、尺寸和适配信息讲清楚。',
    copy: '通过结构化图文版式，让规格信息一眼看懂。',
    visualPrompt: 'Primary Prompt: 规格参数型详情图。避免乱码文字。\nEnglish Prompt: Specification-focused detail.',
    editableFields: { tone: '专业说明' },
  },
  {
    id: 'material_01',
    type: 'material',
    title: '材质工艺说明',
    goal: '补充专业感与品质背书。',
    copy: '把材质和工艺价值解释清楚。',
    visualPrompt: 'Primary Prompt: 材质工艺详情图。主体与参考图一致。\nEnglish Prompt: Material and craftsmanship.',
    editableFields: { tone: '专业背书' },
  },
  {
    id: 'comparison_01',
    type: 'comparison',
    title: '差异化对比',
    goal: '清楚说明为什么值得选这款商品。',
    copy: '用优势对比帮助用户更快完成决策。',
    visualPrompt: 'Primary Prompt: 对比说明型详情图。几何不可反转。\nEnglish Prompt: Comparison-style detail.',
    editableFields: { tone: '价值对比' },
  },
  {
    id: 'brand_trust_01',
    type: 'brand_trust',
    title: '品牌与信任背书',
    goal: '提升品牌感和成交信任感。',
    copy: '通过工艺标准或服务承诺增加下单安心感。',
    visualPrompt: 'Primary Prompt: 品牌背书型详情图。避免乱码文字。\nEnglish Prompt: Brand trust section.',
    editableFields: { tone: '信任建立' },
  },
  {
    id: 'summary_01',
    type: 'summary',
    title: '购买理由总结',
    goal: '形成最后一轮转化推动。',
    copy: '通过总结式收口，帮助用户更快完成购买决策。',
    visualPrompt: 'Primary Prompt: 总结收口型详情图。主体与参考图一致。\nEnglish Prompt: Conversion-closing summary.',
    editableFields: { tone: '收口转化' },
  },
  {
    id: 'gift_scene_01',
    type: 'gift_scene',
    title: '送礼场景',
    goal: '展示作为礼物的使用时刻。',
    copy: '用礼赠场景降低决策成本。',
    visualPrompt: 'Primary Prompt: 送礼场景详情图。主体与参考图一致。\nEnglish Prompt: Gift scene detail.',
    editableFields: { tone: '礼赠' },
  },
  {
    id: 'custom_01',
    type: 'custom',
    title: '补充模块',
    goal: '补足页面叙事。',
    copy: '用一个补充模块收口未覆盖的卖点。',
    visualPrompt: 'Primary Prompt: 自定义详情模块。几何不可反转，避免乱码文字。\nEnglish Prompt: Custom detail module.',
    editableFields: { tone: '补充' },
  },
]

function pad<T>(items: T[], fallback: T[], count: number): T[] {
  const out = items.slice(0, count)
  let i = 0
  while (out.length < count && i < fallback.length) {
    out.push(fallback[i]!)
    i += 1
  }
  while (out.length < count) out.push(fallback[fallback.length - 1] ?? out[0]!)
  return out
}

function normalizeSections(plan: SectionPlanOutput, heroCount: number, detailCount: number): NormalizedSection[] {
  const heroes = pad(plan.sections.filter((section) => section.type === 'hero'), HERO_FALLBACK, heroCount)
  const details = pad(plan.sections.filter((section) => section.type !== 'hero'), DETAIL_FALLBACK, detailCount)
  return [
    ...heroes.map((section, index) => ({
      sectionKey: `hero_${String(index + 1).padStart(2, '0')}`,
      type: 'hero' as const,
      title: section.title || HERO_FALLBACK[index]?.title || `头图${index + 1}`,
      goal: section.goal,
      copy: section.copy,
      visualPrompt: section.visualPrompt,
      editableFields: section.editableFields,
      order: index,
    })),
    ...details.map((section, index) => ({
      sectionKey: `detail_${String(index + 1).padStart(2, '0')}_${section.type}`,
      type: section.type,
      title: section.title,
      goal: section.goal,
      copy: section.copy,
      visualPrompt: section.visualPrompt,
      editableFields: section.editableFields,
      order: heroCount + index,
    })),
  ]
}

export function readPlanFile(projectDir: string): { visualStyleGuide: VisualStyleGuide; sections: NormalizedSection[]; previewConfig?: PreviewConfig } | undefined {
  const file = assertInside(projectDir, join(projectDir, 'plan.json'))
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      visualStyleGuide?: unknown
      sections?: unknown
      previewConfig?: PreviewConfig
    }
    const sections = Array.isArray(raw.sections) ? raw.sections as NormalizedSection[] : []
    return {
      visualStyleGuide: parseVisualStyleGuide(raw.visualStyleGuide),
      sections,
      previewConfig: raw.previewConfig,
    }
  } catch {
    return undefined
  }
}

export function readStyleGuideFile(projectDir: string): VisualStyleGuide | undefined {
  const file = assertInside(projectDir, join(projectDir, 'style-guide.json'))
  if (!existsSync(file)) return undefined
  try {
    return parseVisualStyleGuide(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

function markFailed(store: ProjectStore, projectId: string): void {
  try {
    store.write(projectId, { status: 'failed' })
  } catch {
    // keep original error
  }
}

export async function planPage(
  deps: PlanDeps,
  args: PlanArgs,
  signal: AbortSignal,
): Promise<PlanResult> {
  const record = deps.store.read(args.projectId)
  if (signal.aborted) throw new Error('已取消')
  if (record.status !== 'analyzed' && record.status !== 'planned') {
    return fail('MXPAGE_STATE')
  }
  if (!deps.completeJson) return fail(NO_VISION)

  const analysis = readAnalysisFile(record.workspaceDir)
  if (!analysis) return fail('MXPAGE_STATE')

  const heroCount = clamp(args.heroCount, 1, 5, deps.config.defaultHeroCount)
  const detailCount = clamp(args.detailCount, 1, 10, deps.config.defaultDetailCount)
  const platform: PlanPlatform = args.platform === 'xiaohongshu' ? 'xiaohongshu' : 'ecommerce'
  const language: PromptLanguage = args.language ?? record.language
  const detailAspect: '3:4' | '9:16' = record.aspectRatio === '9:16' ? '9:16' : (record.aspectRatio === '3:4' ? '3:4' : deps.config.defaultDetailAspectRatio)

  try {
    deps.store.write(record.id, { status: 'planning' })
  } catch {
    return fail('MXPAGE_STATE')
  }

  try {
    const user = buildSectionPlanningPrompt(analysis, {
      platform,
      heroCount,
      detailCount,
      language,
    })
    const result = await completeValidatedJson(deps.completeJson, {
      user,
      images: loadProjectImages(record).slice(0, 3),
      parse: parseSectionPlan,
      repairUser: (raw) => `只输出一个 JSON 对象。Repair this section plan JSON:\n${raw}`,
      signal,
    })
    if (!result.ok) {
      markFailed(deps.store, record.id)
      return fail(result.error)
    }
    const sections = normalizeSections(result.value, heroCount, detailCount)
    const visualStyleGuide = result.value.visualStyleGuide
    const previewConfig: PreviewConfig = {
      heroImageCount: heroCount,
      detailSectionCount: detailCount,
      imageAspectRatio: detailAspect,
      contentLanguage: language,
    }
    const planPath = assertInside(record.workspaceDir, join(record.workspaceDir, 'plan.json'))
    const stylePath = assertInside(record.workspaceDir, join(record.workspaceDir, 'style-guide.json'))
    writeFileSync(planPath, JSON.stringify({ visualStyleGuide, sections, previewConfig }, null, 2))
    writeFileSync(stylePath, JSON.stringify(visualStyleGuide, null, 2))
    deps.store.write(record.id, { status: 'planned' })
    return {
      ok: true,
      visualStyleGuide,
      sections,
      previewConfig,
    }
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.message === '已取消')) {
      throw err instanceof Error ? err : new Error('已取消')
    }
    markFailed(deps.store, record.id)
    return fail(err instanceof Error ? err.message : String(err))
  }
}
