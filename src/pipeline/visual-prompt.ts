import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadProjectImages, readAnalysisFile } from './analyze.ts'
import { readPlanFile, readStyleGuideFile, type NormalizedSection } from './plan.ts'
import { buildVisualPromptAgentPrompt, buildVisualPromptRepairPrompt, type VpaMode } from '../prompts/visual-prompt-agent.ts'
import { completeValidatedJson, NO_VISION, type CompleteJson } from '../provider/vision-text.ts'
import { parseVisualPrompt, type VisualPromptOutput } from '../schemas/visual-prompt.ts'
import type { ProjectStore } from '../service/project-store.ts'
import { assertInside } from '../util/paths.ts'
import { redactSecrets } from '../util/redact.ts'

export interface RefineArgs {
  projectId: string
  sectionKey: string
  mode?: VpaMode
}

export type RefineResult =
  | { ok: true; analysisSummary: string; finalPrompt: string; negativePrompt: string; qualityChecklist: string[]; [key: string]: unknown }
  | { ok: false; error: string; [key: string]: unknown }

export interface RefineDeps {
  store: ProjectStore
  completeJson?: CompleteJson
}

function fail(error: string): RefineResult {
  return { ok: false, error: redactSecrets(error) }
}

function syntheticSection(sectionKey: string, productName: string): NormalizedSection {
  const isHero = /^hero_/i.test(sectionKey)
  return {
    sectionKey,
    type: isHero ? 'hero' : 'custom',
    title: productName || sectionKey,
    goal: isHero ? '建立第一眼商品记忆点' : '展示该模块的核心卖点',
    copy: '',
    visualPrompt: '',
    editableFields: {},
    order: 0,
  }
}

export async function refinePrompt(
  deps: RefineDeps,
  args: RefineArgs,
  signal: AbortSignal,
): Promise<RefineResult> {
  const record = deps.store.read(args.projectId)
  if (signal.aborted) throw new Error('已取消')
  if (!deps.completeJson) return fail(NO_VISION)

  const analysis = readAnalysisFile(record.workspaceDir)
  if (!analysis) return fail('MXPAGE_STATE')

  const plan = readPlanFile(record.workspaceDir)
  const styleGuide = readStyleGuideFile(record.workspaceDir) ?? plan?.visualStyleGuide
  const section = plan?.sections.find((item) => item.sectionKey === args.sectionKey)
    ?? syntheticSection(args.sectionKey, analysis.productName)

  const aspectRatio = section.type === 'hero'
    ? '1:1'
    : record.aspectRatio === '9:16'
      ? '9:16'
      : '3:4'
  const mode: VpaMode = args.mode ?? 'ecommerce_section'

  try {
    const user = buildVisualPromptAgentPrompt({
      mode,
      title: section.title,
      goal: section.goal,
      copy: section.copy,
      basePrompt: section.visualPrompt,
      aspectRatio,
      contentLanguage: record.language,
      referenceRoles: record.assets.map((asset) => ({
        role: asset.role,
        isMain: asset.role === 'main' || asset.path === record.mainAssetPath,
      })),
      productContext: analysis,
      visualStyleGuide: styleGuide,
    })
    const result = await completeValidatedJson(deps.completeJson, {
      user,
      images: loadProjectImages(record).slice(0, 3),
      parse: parseVisualPrompt,
      repairUser: buildVisualPromptRepairPrompt,
      signal,
    })
    if (!result.ok) return fail(result.error)
    const dir = assertInside(record.workspaceDir, join(record.workspaceDir, 'prompts'))
    mkdirSync(dir, { recursive: true })
    const file = assertInside(record.workspaceDir, join(dir, `${args.sectionKey}.json`))
    const payload: VisualPromptOutput = result.value
    writeFileSync(file, JSON.stringify(payload, null, 2))
    return {
      ok: true,
      analysisSummary: payload.analysisSummary,
      finalPrompt: payload.finalPrompt,
      negativePrompt: payload.negativePrompt,
      qualityChecklist: payload.qualityChecklist,
    }
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.message === '已取消')) {
      throw err instanceof Error ? err : new Error('已取消')
    }
    return fail(err instanceof Error ? err.message : String(err))
  }
}

