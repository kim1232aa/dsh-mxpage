import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProductAnalysisPrompt, buildProductAnalysisRepairPrompt } from '../prompts/analysis.ts'
import { completeValidatedJson, NO_VISION, type CompleteJson } from '../provider/vision-text.ts'
import { parseProductAnalysis, type ProductAnalysisOutput } from '../schemas/product-analysis.ts'
import type { ProjectRecord, ProjectStore } from '../service/project-store.ts'
import { readImageFile } from '../util/images.ts'
import { assertInside } from '../util/paths.ts'
import { redactSecrets } from '../util/redact.ts'

export interface AnalyzeArgs {
  projectId: string
  model?: string
}

export type AnalyzeResult =
  | { ok: true; projectId: string; modelUsed: string; analysis: ProductAnalysisOutput; [key: string]: unknown }
  | { ok: false; error: string; [key: string]: unknown }

export interface AnalyzeDeps {
  store: ProjectStore
  completeJson?: CompleteJson
}

function fail(error: string): AnalyzeResult {
  return { ok: false, error: redactSecrets(error) }
}

export function readAnalysisFile(projectDir: string): ProductAnalysisOutput | undefined {
  const file = assertInside(projectDir, join(projectDir, 'analysis.json'))
  if (!existsSync(file)) return undefined
  try {
    return parseProductAnalysis(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

export function loadProjectImages(record: ProjectRecord): Array<{ bytes: Uint8Array; mediaType: string }> {
  const ordered = [
    ...record.assets.filter((asset) => asset.path === record.mainAssetPath || asset.role === 'main'),
    ...record.assets.filter((asset) => asset.path !== record.mainAssetPath && asset.role !== 'main'),
  ]
  const seen = new Set<string>()
  const images: Array<{ bytes: Uint8Array; mediaType: string }> = []
  for (const asset of ordered) {
    if (seen.has(asset.path)) continue
    seen.add(asset.path)
    if (!existsSync(asset.path)) continue
    try {
      images.push(readImageFile(asset.path))
    } catch {
      continue
    }
    if (images.length >= 10) break
  }
  return images
}

function markFailed(store: ProjectStore, projectId: string): void {
  try {
    store.write(projectId, { status: 'failed' })
  } catch {
    // keep original error
  }
}

export async function analyzeProduct(
  deps: AnalyzeDeps,
  args: AnalyzeArgs,
  signal: AbortSignal,
): Promise<AnalyzeResult> {
  const record = deps.store.read(args.projectId)
  if (signal.aborted) throw new Error('已取消')
  if (!deps.completeJson) return fail(NO_VISION)

  const status = record.status
  if (status !== 'created' && status !== 'failed' && status !== 'analyzing') {
    return fail('MXPAGE_STATE')
  }
  if (status === 'created' || status === 'failed') {
    try {
      deps.store.write(record.id, { status: 'analyzing' })
    } catch {
      return fail('MXPAGE_STATE')
    }
  }

  try {
    const images = loadProjectImages(record)
    if (images.length === 0) {
      markFailed(deps.store, record.id)
      return fail(NO_VISION)
    }
    const user = buildProductAnalysisPrompt(
      record.assets.map((asset) => ({
        role: asset.role,
        isMain: asset.role === 'main' || asset.path === record.mainAssetPath,
      })),
    )
    const result = await completeValidatedJson(deps.completeJson, {
      user,
      images,
      parse: parseProductAnalysis,
      repairUser: buildProductAnalysisRepairPrompt,
      signal,
      model: args.model,
    })
    if (!result.ok) {
      markFailed(deps.store, record.id)
      return fail(result.error)
    }
    const analysisPath = assertInside(record.workspaceDir, join(record.workspaceDir, 'analysis.json'))
    writeFileSync(analysisPath, JSON.stringify(result.value, null, 2))
    deps.store.write(record.id, { status: 'analyzed' })
    return {
      ok: true,
      projectId: record.id,
      modelUsed: result.modelUsed,
      analysis: result.value,
    }
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.message === '已取消')) {
      throw err instanceof Error ? err : new Error('已取消')
    }
    markFailed(deps.store, record.id)
    return fail(err instanceof Error ? err.message : String(err))
  }
}
