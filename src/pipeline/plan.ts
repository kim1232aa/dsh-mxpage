import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import { loadProjectImages, readAnalysisFile } from './analyze.ts'
import { buildSectionPlanningPrompt, type PlanPlatform, type PromptLanguage } from '../prompts/planning.ts'
import { completeValidatedJson, NO_VISION, type CompleteJson } from '../provider/vision-text.ts'
import {
  parseSectionPlan,
  parseVisualStyleGuide,
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

function normalizeSections(plan: SectionPlanOutput): NormalizedSection[] {
  const heroes = plan.sections.filter((section) => section.type === 'hero')
  const details = plan.sections.filter((section) => section.type !== 'hero')
  return [
    ...heroes.map((section, index) => ({
      sectionKey: `hero_${String(index + 1).padStart(2, '0')}`,
      type: 'hero' as const,
      title: section.title || `头图${index + 1}`,
      goal: section.goal,
      copy: section.copy,
      visualPrompt: section.visualPrompt,
      editableFields: section.editableFields,
      order: index,
    })),
    ...details.map((section, index) => ({
      sectionKey: `detail_${String(index + 1).padStart(2, '0')}_${section.type}`,
      type: section.type,
      title: section.title || `详情${index + 1}`,
      goal: section.goal,
      copy: section.copy,
      visualPrompt: section.visualPrompt,
      editableFields: section.editableFields,
      order: heroes.length + index,
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
    const sections = normalizeSections(result.value)
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
