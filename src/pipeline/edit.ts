import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { nextVersionId, rememberOutput } from './generate.ts'
import { readAnalysisFile } from './analyze.ts'
import { readPlanFile } from './plan.ts'
import type { Config } from '../config.ts'
import { buildImageEditPrompt, type EditMode, type PromptLanguage } from '../prompts/generation.ts'
import type { ImageBlob, ImageSize, ImagesClient } from '../provider/openai-images.ts'
import type { ProjectStore } from '../service/project-store.ts'
import { readImageFile } from '../util/images.ts'
import { assertInside } from '../util/paths.ts'
import { redactSecrets } from '../util/redact.ts'

export interface EditSectionArgs {
  projectId: string
  sectionKey: string
  mode: EditMode
  instruction?: string
  targetLanguage?: PromptLanguage
  size?: ImageSize
  model?: string
}

export interface EditSectionOk {
  ok: true
  projectId: string
  sectionKey: string
  outputPath: string
  attachmentId: string
  modelUsed: string
  versionId: string
  [key: string]: string | number | boolean
}

export interface EditSectionFail {
  ok: false
  error: string
  [key: string]: string | number | boolean
}

export type EditSectionResult = EditSectionOk | EditSectionFail

export interface EditSectionDeps {
  store: ProjectStore
  storeRoot: string
  config: Config
  images: ImagesClient
  saveImage: (input: {
    data: Uint8Array
    mediaType: 'image/png' | string
    name?: string
  }) => Promise<{
    attachmentId: string
    mediaType?: string
    bytes?: number
    width?: number
    height?: number
    name?: string
  }>
}

function fail(error: string): EditSectionFail {
  return { ok: false, error: redactSecrets(error) }
}

function toBlob(absPath: string): ImageBlob {
  const { bytes, mediaType } = readImageFile(absPath)
  return { bytes, mediaType, filename: basename(absPath) }
}

function tryStatus(store: ProjectStore, projectId: string, status: string): void {
  try {
    store.write(projectId, { status })
  } catch {
    // keep going if the transition is illegal (e.g. P1 created → editing)
  }
}

export async function editSection(
  deps: EditSectionDeps,
  args: EditSectionArgs,
  signal: AbortSignal,
): Promise<EditSectionResult> {
  const record = deps.store.read(args.projectId)
  if (signal.aborted) throw new Error('已取消')

  const projectDir = record.workspaceDir
  const outputPath = assertInside(projectDir, join(projectDir, 'output', `${args.sectionKey}.png`))
  if (!existsSync(outputPath)) return fail('MXPAGE_NOT_FOUND')

  const plan = readPlanFile(projectDir)
  const section = plan?.sections.find((item) => item.sectionKey === args.sectionKey)
  const generation = {
    type: section?.type ?? (args.sectionKey.startsWith('hero_') ? 'hero' : 'custom'),
    title: section?.title ?? args.sectionKey,
    goal: section?.goal ?? args.instruction ?? '',
    copy: section?.copy ?? '',
    visualPrompt: section?.visualPrompt ?? args.instruction ?? '',
  }
  const aspectRatio = generation.type === 'hero'
    ? '1:1'
    : record.aspectRatio === '9:16'
      ? '9:16'
      : record.aspectRatio === '3:4'
        ? '3:4'
        : '3:4'
  const contentLanguage: PromptLanguage = args.mode === 'translate'
    ? (args.targetLanguage ?? record.language)
    : record.language
  const analysis = readAnalysisFile(projectDir)
  const referenceAssets = [
    { role: 'output', isMain: false },
    { role: 'main', isMain: true },
  ]
  let prompt = buildImageEditPrompt(
    generation,
    referenceAssets,
    args.mode,
    aspectRatio,
    contentLanguage,
    analysis?.generationRequirements,
  )
  if (args.instruction?.trim()) {
    prompt = `${prompt}\nUser instruction: ${args.instruction.trim()}`
  }

  const image = toBlob(outputPath)
  const references: ImageBlob[] = [image]
  if (record.mainAssetPath && existsSync(record.mainAssetPath)) {
    references.push(toBlob(record.mainAssetPath))
  }

  tryStatus(deps.store, record.id, 'editing')

  const model = args.model ?? deps.config.imageModel
  const size: ImageSize = args.size ?? '1024x1024'
  const generated = await deps.images.edit({
    prompt,
    size,
    model,
    image,
    references,
    signal,
  })

  if (signal.aborted) throw new Error('已取消')

  const versionId = nextVersionId(projectDir, args.sectionKey)
  const versionDir = assertInside(projectDir, join(projectDir, 'versions', args.sectionKey))
  mkdirSync(versionDir, { recursive: true })
  const versionPath = assertInside(projectDir, join(versionDir, `${versionId}.png`))
  const buf = Buffer.from(generated.bytes)
  writeFileSync(outputPath, buf)
  writeFileSync(versionPath, buf)

  const ref = await deps.saveImage({
    data: generated.bytes,
    mediaType: generated.mediaType,
    name: `${args.sectionKey}.png`,
  })
  rememberOutput(deps.store, record.id, {
    key: args.sectionKey,
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType ?? generated.mediaType,
    bytes: ref.bytes ?? generated.bytes.byteLength,
    width: ref.width ?? 0,
    height: ref.height ?? 0,
    name: ref.name ?? `${args.sectionKey}.png`,
  })

  tryStatus(deps.store, record.id, 'generated')

  return {
    ok: true,
    projectId: record.id,
    sectionKey: args.sectionKey,
    outputPath,
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType ?? generated.mediaType,
    bytes: ref.bytes ?? generated.bytes.byteLength,
    width: ref.width ?? 0,
    height: ref.height ?? 0,
    modelUsed: model,
    versionId,
  }
}
