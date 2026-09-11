import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Config } from '../config.ts'
import type { ImageBlob, ImageSize, ImagesClient } from '../provider/openai-images.ts'
import type { CompleteJson } from '../provider/vision-text.ts'
import type { ProjectRecord, ProjectStore } from '../service/project-store.ts'
import { readImageFile } from '../util/images.ts'
import { assertInside } from '../util/paths.ts'
import { redactSecrets } from '../util/redact.ts'
import { refinePrompt } from './visual-prompt.ts'

const MISSING_PROMPT = 'missing prompt; call mxpage_refine_prompt or pass prompt_override'

export interface GenerateSectionArgs {
  projectId: string
  sectionKey: string
  promptOverride?: string
  referencePaths?: string[]
  size?: ImageSize
  model?: string
}

export interface GenerateSectionOk {
  ok: true
  projectId: string
  sectionKey: string
  outputPath: string
  attachmentId: string
  modelUsed: string
  versionId: string
  [key: string]: string | number | boolean
}

export interface GenerateSectionFail {
  ok: false
  error: string
  [key: string]: string | number | boolean
}

export type GenerateSectionResult = GenerateSectionOk | GenerateSectionFail

export interface GenerateSectionDeps {
  store: ProjectStore
  storeRoot: string
  config: Config
  images: ImagesClient
  saveImage: (input: {
    data: Uint8Array
    mediaType: 'image/png'
    name?: string
  }) => Promise<{ attachmentId: string }>
  completeJson?: CompleteJson
}

function fail(error: string): GenerateSectionFail {
  return { ok: false, error: redactSecrets(error) }
}

function readPromptFile(projectDir: string, sectionKey: string): string | undefined {
  const file = assertInside(projectDir, join(projectDir, 'prompts', `${sectionKey}.json`))
  if (!existsSync(file)) return undefined
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      finalPrompt?: unknown
      prompt?: unknown
    }
    if (typeof data.finalPrompt === 'string' && data.finalPrompt.trim()) return data.finalPrompt
    if (typeof data.prompt === 'string' && data.prompt.trim()) return data.prompt
  } catch {
    return undefined
  }
  return undefined
}

export function resolvePrompt(projectDir: string, sectionKey: string, promptOverride?: string): string | undefined {
  if (promptOverride !== undefined && promptOverride.trim() !== '') return promptOverride
  return readPromptFile(projectDir, sectionKey)
}

export function latestVersionId(projectDir: string, sectionKey: string): string | undefined {
  const dir = join(projectDir, 'versions', sectionKey)
  if (!existsSync(dir)) return undefined
  let max = 0
  for (const name of readdirSync(dir)) {
    const match = /^v(\d+)\.png$/.exec(name)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max > 0 ? `v${max}` : undefined
}

export function nextVersionId(projectDir: string, sectionKey: string): string {
  const current = latestVersionId(projectDir, sectionKey)
  if (!current) return 'v1'
  return `v${Number(current.slice(1)) + 1}`
}

export function listOutputSections(projectDir: string): Array<{
  key: string
  outputPath: string
  versionId?: string
}> {
  const outputDir = join(projectDir, 'output')
  if (!existsSync(outputDir)) return []
  return readdirSync(outputDir)
    .filter((name) => name.endsWith('.png'))
    .sort()
    .map((name) => {
      const key = name.slice(0, -'.png'.length)
      return {
        key,
        outputPath: join(outputDir, name),
        versionId: latestVersionId(projectDir, key),
      }
    })
}

function firstHeroOutput(projectDir: string): string | undefined {
  const outputDir = join(projectDir, 'output')
  if (!existsSync(outputDir)) return undefined
  const names = readdirSync(outputDir)
    .filter((name) => /^hero_.*\.png$/i.test(name))
    .sort()
  const first = names[0]
  return first ? join(outputDir, first) : undefined
}

function defaultReferencePaths(record: ProjectRecord, max: number): string[] {
  const paths: string[] = []
  if (record.mainAssetPath) paths.push(record.mainAssetPath)
  const hero = firstHeroOutput(record.workspaceDir)
  if (hero && !paths.includes(hero)) paths.push(hero)
  return paths.slice(0, max)
}

function toBlob(absPath: string): ImageBlob {
  const { bytes, mediaType } = readImageFile(absPath)
  return { bytes, mediaType, filename: basename(absPath) }
}

function loadReferences(
  storeRoot: string,
  record: ProjectRecord,
  config: Config,
  referencePaths?: string[],
): ImageBlob[] {
  const paths = referencePaths !== undefined
    ? referencePaths.map((path) => assertInside(storeRoot, path))
    : defaultReferencePaths(record, config.maxReferenceImages)
  return paths.slice(0, config.maxReferenceImages).filter((path) => existsSync(path)).map(toBlob)
}

export async function generateSection(
  deps: GenerateSectionDeps,
  args: GenerateSectionArgs,
  signal: AbortSignal,
): Promise<GenerateSectionResult> {
  const record = deps.store.read(args.projectId)
  let prompt = resolvePrompt(record.workspaceDir, args.sectionKey, args.promptOverride)
  if (!prompt && deps.completeJson) {
    const refined = await refinePrompt(
      { store: deps.store, completeJson: deps.completeJson },
      { projectId: args.projectId, sectionKey: args.sectionKey },
      signal,
    )
    if (refined.ok) prompt = refined.finalPrompt
  }
  if (!prompt) return fail(MISSING_PROMPT)

  const model = args.model ?? deps.config.imageModel
  const size: ImageSize = args.size ?? '1024x1024'
  const references = loadReferences(deps.storeRoot, record, deps.config, args.referencePaths)

  const generated = await deps.images.generate({
    prompt,
    size,
    model,
    references,
    signal,
  })

  if (signal.aborted) throw new Error('已取消')

  const projectDir = record.workspaceDir
  const versionId = nextVersionId(projectDir, args.sectionKey)
  const outputDir = assertInside(projectDir, join(projectDir, 'output'))
  const versionDir = assertInside(projectDir, join(projectDir, 'versions', args.sectionKey))
  mkdirSync(outputDir, { recursive: true })
  mkdirSync(versionDir, { recursive: true })
  const outputPath = assertInside(projectDir, join(outputDir, `${args.sectionKey}.png`))
  const versionPath = assertInside(projectDir, join(versionDir, `${versionId}.png`))
  const buf = Buffer.from(generated.bytes)
  writeFileSync(outputPath, buf)
  writeFileSync(versionPath, buf)

  const ref = await deps.saveImage({
    data: generated.bytes,
    mediaType: 'image/png',
    name: `${args.sectionKey}.png`,
  })

  return {
    ok: true,
    projectId: record.id,
    sectionKey: args.sectionKey,
    outputPath,
    attachmentId: ref.attachmentId,
    modelUsed: model,
    versionId,
  }
}
