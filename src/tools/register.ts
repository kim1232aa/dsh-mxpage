/**
 * DSH tool surface for MxPage.
 *
 * Every tool is a thin wrapper over `mxpage-core` services — no business logic
 * lives here. Tool names are `mxpage_*` only; the plugin never registers
 * `generate_image` / `edit_image`, because image channels are reached through
 * the ProviderResolver port instead of competing with `dsh-imagegen`.
 *
 * Envelope convention (kept from the upstream tool contract):
 *   - business failures → `{ ok: false, error: <CODE>, message? }` inside a
 *     successful tool result
 *   - infrastructure failures → `throw`
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Config } from '../config.ts'
import type { MxpageRuntime } from '../host/index.ts'
import { resolveStoreRoot } from '../host/index.ts'
import { redactSecrets } from '../util/redact.ts'

// ---------------------------------------------------------------------------
// Host surface
// ---------------------------------------------------------------------------

export interface ImageRef {
  attachmentId: string
  mediaType?: string
  bytes?: number
  width?: number
  height?: number
  name?: string
}

export interface MxpageToolsHost {
  tools: { register: (tool: unknown) => (() => void) | undefined }
  attachments: {
    saveImage?: (input: {
      data: Uint8Array
      mediaType: string
      name?: string
    }) => Promise<ImageRef>
    readImage?: (
      ref: { attachmentId: string },
      signal?: AbortSignal,
    ) => Promise<{ data: Uint8Array; ref?: { mediaType?: string; name?: string } }>
    imageHostPath?: (ref: { attachmentId: string }) => string | undefined
  }
}

type ExecContext = { signal?: AbortSignal }

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const objectSchema = { type: 'object', additionalProperties: true } as const

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/**
 * Envelope helpers.
 *
 * `defineTool` constrains `execute` to resolve to `Record<string, JsonValue>`,
 * but our services legitimately return domain objects (Dates, `unknown` JSON
 * columns) that `render` serializes. Rather than sprinkle per-call casts, the
 * helpers declare `never` so they satisfy any execute signature while still
 * producing the correct runtime shape. The envelope contract is asserted by
 * `assertEnvelope` in the test suite instead of by the compiler.
 */
function ok<T extends Record<string, unknown>>(data: T): never {
  return { ok: true as const, ...data } as never
}

/** Business failure. `message` is always present so the shape is index-safe. */
function fail(error: string, message = ''): never {
  return { ok: false as const, error, message } as never
}

/** Maps a thrown error onto the stable upstream error codes. */
function toFailure(error: unknown): never {
  const message = redactSecrets(error instanceof Error ? error.message : String(error))
  const code = /429|rate limit|quota|insufficient_quota|额度|限流/i.test(message)
    ? 'MXPAGE_HTTP_429'
    : /401|403|unauthorized|invalid token|api key|密钥|未配置/i.test(message)
      ? 'MXPAGE_HTTP_401'
      : /400|unsupported|invalid_value|不支持/i.test(message)
        ? 'MXPAGE_HTTP_400'
        : /cancel|取消/i.test(message)
          ? 'MXPAGE_CANCELLED'
          : /not found|不存在/i.test(message)
            ? 'MXPAGE_NOT_FOUND'
            : 'MXPAGE_ERROR'
  return { ok: false as const, error: code, message } as never
}

const SECTION_ROLES = ['main', 'angle', 'detail', 'reference'] as const
const ASPECT_ENUM = ['1:1', '3:4', '9:16'] as const
/**
 * Upstream's detail-page preview config only accepts the two vertical ratios
 * (1:1 belongs to the square hero gallery), so the planning tool is narrower
 * than the generation tools.
 */
const DETAIL_ASPECT_ENUM = ['3:4', '9:16'] as const

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMxpageTools(
  ctx: MxpageToolsHost,
  config: Config,
  runtime: MxpageRuntime,
): Array<(() => void) | undefined> {
  const storeRoot = resolveStoreRoot(config)
  const { analysis, planner, generation, exportService, xiaohongshu, tasks, assets, host } = runtime

  /** Reads a produced asset and hands its bytes to the host attachment store. */
  async function attachAsset(asset: {
    filePath: string
    mimeType?: string | null
    fileName: string
  }): Promise<ImageRef | undefined> {
    if (!ctx.attachments.saveImage) return undefined
    const bytes = await assets.readStorageFile(asset.filePath)
    return ctx.attachments.saveImage({
      data: new Uint8Array(bytes),
      mediaType: asset.mimeType ?? 'image/png',
      name: asset.fileName,
    })
  }

  /**
   * Materializes a chat attachment (an image the user pasted into the
   * conversation) into bytes. Prefers the host path when the host exposes one,
   * otherwise reads through the attachment store.
   */
  async function readAttachment(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<{ data: Buffer; fileName: string; mimeType: string }> {
    const id = attachmentId.trim()
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new Error('invalid attachment id')
    }
    const hostPath = ctx.attachments.imageHostPath?.({ attachmentId: id })
    if (hostPath) {
      return { data: await readLocalFile(hostPath), fileName: basename(hostPath), mimeType: guessMime(hostPath) }
    }
    if (ctx.attachments.readImage) {
      const stored = await ctx.attachments.readImage({ attachmentId: id }, signal)
      const fileName = stored.ref?.name ?? `${id}.png`
      return {
        data: Buffer.from(stored.data),
        fileName,
        mimeType: stored.ref?.mediaType ?? guessMime(fileName),
      }
    }
    throw new Error('无法读取附件：宿主未提供 attachments.readImage 或 imageHostPath')
  }

  /** Normalizes the `image_paths` + `attachment_ids` pair into one source list. */
  async function collectSources(
    imagePaths: string[] | undefined,
    attachmentIds: string[] | undefined,
    signal?: AbortSignal,
  ): Promise<Array<{ data: Buffer; fileName: string; mimeType: string }>> {
    const sources: Array<{ data: Buffer; fileName: string; mimeType: string }> = []
    for (const source of imagePaths ?? []) {
      sources.push({
        data: await readLocalFile(source),
        fileName: basename(source),
        mimeType: guessMime(source),
      })
    }
    for (const id of attachmentIds ?? []) {
      sources.push(await readAttachment(id, signal))
    }
    return sources
  }

  const disposers: Array<(() => void) | undefined> = []

  // -- projects --------------------------------------------------------------

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_create_project',
        description:
          'Create an MxPage ecommerce project from 1–10 product photos, supplied either as chat attachments (attachment_ids) or as workspace files (image_paths). Bytes are copied, never moved; the first image becomes the main reference. Returns the project id used by every other mxpage_* tool.',
        parameters: {
          name: { type: 'string', description: 'Project name. Defaults to untitled.' },
          image_paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths to existing image files on this machine.',
          },
          attachment_ids: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Image attachment ids from the current conversation — the normal way to use a photo the user just pasted. Combined with image_paths, 1–10 total.',
          },
          platform: {
            type: 'string',
            description:
              'general_ecommerce | taobao_tmall | pinduoduo | xiaohongshu | douyin_ecommerce',
          },
          style: {
            type: 'string',
            description:
              'generic_clean | premium | soft_lifestyle | conversion_focused | tech',
          },
          language: { type: 'string', description: 'In-image copy language, e.g. zh-CN | en-US | ja-JP | ko-KR' },
          aspect_ratio: { type: 'string', enum: [...ASPECT_ENUM], description: 'Detail-page aspect ratio. Defaults to 3:4.' },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args, exec: ExecContext) {
          try {
            const sources = await collectSources(
              args.image_paths as string[] | undefined,
              args.attachment_ids as string[] | undefined,
              exec.signal,
            )
            if (sources.length < 1 || sources.length > 10) {
              return fail(
                'MXPAGE_INPUT',
                'supply 1–10 product photos via image_paths and/or attachment_ids',
              )
            }
            const project = await host.repository.project.create({
              name: (args.name as string | undefined) ?? 'untitled',
              platform: (args.platform as string | undefined) ?? config.defaultPlatform,
              style: (args.style as string | undefined) ?? config.defaultStyle,
            })

            const stored: string[] = []
            for (const [index, source] of sources.entries()) {
              const asset = await assets.saveUploadAsset({
                projectId: project.id,
                type: index === 0 ? 'MAIN' : 'REFERENCE',
                fileName: source.fileName,
                mimeType: source.mimeType,
                fileBuffer: source.data,
                sortOrder: index,
                isMain: index === 0,
              })
              stored.push(asset.filePath)
            }

            await host.repository.project.mergeModelSnapshot(project.id, {
              previewConfig: {
                heroImageCount: config.defaultHeroCount,
                detailSectionCount: config.defaultDetailCount,
                imageAspectRatio: config.defaultDetailAspectRatio,
                contentLanguage: (args.language as string | undefined) ?? config.defaultLanguage,
              },
            })

            return ok({
              projectId: project.id,
              assetCount: stored.length,
              mainAssetPath: stored[0],
              workspaceDir: storeRoot,
            })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_add_asset',
        description:
          'Append one product photo to an existing MxPage project, from a chat attachment or a workspace file. Pass role=main to make it the primary reference; the previous main becomes a reference. Max 10 assets per project.',
        parameters: {
          project_id: { type: 'string', required: true },
          image_path: { type: 'string', description: 'Absolute path to an existing image file.' },
          attachment_id: {
            type: 'string',
            description: 'Image attachment id from the current conversation. Supply this or image_path.',
          },
          role: { type: 'string', enum: [...SECTION_ROLES], description: 'Defaults to reference.' },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args, exec: ExecContext) {
          try {
            const projectId = args.project_id as string
            const role = ((args.role as string | undefined) ?? 'reference').toLowerCase()
            const count = await host.repository.asset.count(projectId)
            if (count >= 10) return fail('MXPAGE_INPUT', 'max 10 assets per project')

            const imagePath = args.image_path as string | undefined
            const attachmentId = args.attachment_id as string | undefined
            if (!imagePath && !attachmentId) {
              return fail('MXPAGE_INPUT', 'supply image_path or attachment_id')
            }
            const source = imagePath
              ? {
                  data: await readLocalFile(imagePath),
                  fileName: basename(imagePath),
                  mimeType: guessMime(imagePath),
                }
              : await readAttachment(attachmentId!, exec.signal)

            const asset = await assets.saveUploadAsset({
              projectId,
              type: role.toUpperCase() as 'MAIN' | 'ANGLE' | 'DETAIL' | 'REFERENCE',
              fileName: source.fileName,
              mimeType: source.mimeType,
              fileBuffer: source.data,
              sortOrder: count,
              isMain: role === 'main',
            })
            if (role === 'main') await host.repository.asset.setMain(projectId, asset.id)
            return ok({ projectId, assetId: asset.id, assetCount: count + 1 })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_project_status',
        description:
          'Read-only snapshot of an MxPage project: status, analysis presence, every section with its generation status and version count, plus any running task.',
        parameters: { project_id: { type: 'string', required: true } },
        output: { schema: objectSchema, render: renderJson },
        async execute(args) {
          try {
            const projectId = args.project_id as string
            const detail = await host.repository.project.getDetail(projectId)
            if (!detail) return fail('MXPAGE_NOT_FOUND', `unknown project ${projectId}`)

            const recent = await host.repository.task.list(projectId, 5)
            return ok({
              projectId,
              name: detail.name,
              status: detail.status,
              assetCount: detail.assets.length,
              analyzed: !!detail.analysis,
              previewConfig:
                (detail.modelSnapshot as Record<string, unknown> | null)?.previewConfig ?? null,
              sections: detail.sections.map((section) => ({
                id: section.id,
                sectionKey: section.sectionKey,
                type: section.type,
                title: section.title,
                order: section.order,
                status: section.status,
                hasImage: !!section.currentImageAssetId,
                versionCount: section.versions.length,
              })),
              runningTasks: recent
                .filter((task) => task.status === 'RUNNING' || task.status === 'PENDING')
                .map((task) => ({
                  id: task.id,
                  taskType: task.taskType,
                  status: task.status,
                  progress: task.outputPayload ?? null,
                })),
            })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  // -- analyze → plan --------------------------------------------------------

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_analyze_product',
        description:
          "Vision analysis of a project's product photos: category, material, selling points, audience and a suggested section plan. Must run before mxpage_plan_page.",
        parameters: {
          project_id: { type: 'string', required: true },
          model: { type: 'string', description: 'Override the analysis model id.' },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args) {
          try {
            const result = await analysis.analyzeProject(
              args.project_id as string,
              (args.model as string | undefined) ?? null,
            )
            return ok({ projectId: args.project_id, analysis: result.normalizedResult })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_plan_page',
        description:
          'Plan the detail page: one project-level visual style guide plus hero and detail sections, each with copy, a two-part visual prompt and negative constraints. WARNING: re-planning deletes all existing sections, versions and their images. Requires a prior mxpage_analyze_product.',
        parameters: {
          project_id: { type: 'string', required: true },
          hero_count: { type: 'integer', description: '1–5 hero images. Defaults to 3.' },
          detail_count: { type: 'integer', description: '1–10 detail sections. Defaults to 6.' },
          aspect_ratio: { type: 'string', enum: [...DETAIL_ASPECT_ENUM] },
          language: { type: 'string', description: 'In-image copy language.' },
          auto_decide_counts: { type: 'boolean', description: 'Let the model choose hero/detail counts.' },
          model: { type: 'string', description: 'Override the planning model id.' },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args) {
          try {
            const projectId = args.project_id as string
            const detail = await host.repository.project.getDetail(projectId)
            if (!detail) return fail('MXPAGE_NOT_FOUND', `unknown project ${projectId}`)
            if (!detail.analysis) {
              return fail('MXPAGE_STATE', 'run mxpage_analyze_product first')
            }

            const result = await planner.planSections(projectId, {
              modelId: (args.model as string | undefined) ?? null,
              previewConfig: {
                heroImageCount: clamp(args.hero_count as number | undefined, 1, 5, config.defaultHeroCount),
                detailSectionCount: clamp(
                  args.detail_count as number | undefined,
                  1,
                  10,
                  config.defaultDetailCount,
                ),
                imageAspectRatio: ((args.aspect_ratio as string | undefined) ??
                  config.defaultDetailAspectRatio) as '3:4' | '9:16',
                contentLanguage: ((args.language as string | undefined) ??
                  config.defaultLanguage) as never,
              },
              autoDecideCounts: args.auto_decide_counts === true,
            })

            return ok({
              projectId,
              visualStyleGuide: result.visualStyleGuide,
              previewConfig: result.previewConfig,
              fallbackMode: result.fallbackMode ?? null,
              sections: result.sections.map((section) => ({
                id: section.id,
                sectionKey: section.sectionKey,
                type: section.type,
                title: section.title,
                order: section.order,
              })),
            })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  // -- generation ------------------------------------------------------------

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_generate_section',
        description:
          'Generate one section image. Runs the Visual Prompt Agent first unless prompt_override is given, then calls the image API with the main product photo (plus the first successful hero) as references. Creates a new version; never overwrites. Consumes paid image quota.',
        parameters: {
          project_id: { type: 'string', required: true },
          section_id: { type: 'string', required: true },
          prompt_override: { type: 'string', description: 'Skip the Visual Prompt Agent and use this prompt verbatim.' },
          reference_asset_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Override the default reference assets.',
          },
          model: { type: 'string', description: 'Override the image model id.' },
          regenerate: {
            type: 'boolean',
            description: 'Use the regeneration variant (keeps product identity, improves quality).',
          },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args) {
          try {
            const projectId = args.project_id as string
            const sectionId = args.section_id as string
            const invoke =
              args.regenerate === true
                ? generation.regenerateSectionImage
                : generation.generateSectionImage
            const result = await invoke(
              projectId,
              sectionId,
              (args.model as string | undefined) ?? null,
              args.reference_asset_ids as string[] | undefined,
            )
            const attachment = await attachAsset(result.imageAsset)
            return ok({
              projectId,
              sectionId,
              versionId: result.version.id,
              versionNumber: result.version.versionNumber,
              modelUsed: result.usedModel,
              generationMode: result.generationMode,
              outputPath: result.imageAsset.filePath,
              attachmentId: attachment?.attachmentId,
            })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_edit_section',
        description:
          'Edit an existing section image: repaint (new composition), enhance (same framing, better realism) or translate (re-letter every in-image word into the target language). Creates a new version; never overwrites.',
        parameters: {
          project_id: { type: 'string', required: true },
          section_id: { type: 'string', required: true },
          mode: { type: 'string', enum: ['repaint', 'enhance', 'translate'], required: true },
          instruction: { type: 'string', description: 'Extra direction for repaint/enhance.' },
          target_language: { type: 'string', description: 'Required when mode=translate.' },
          model: { type: 'string', description: 'Override the image model id.' },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args) {
          try {
            const editMode = args.mode as 'repaint' | 'enhance' | 'translate'
            if (editMode === 'translate' && !args.target_language) {
              return fail('MXPAGE_MISSING_LANGUAGE', 'target_language is required when mode=translate')
            }
            const result = await generation.editSectionImage(
              args.project_id as string,
              args.section_id as string,
              {
                preferredModelId: (args.model as string | undefined) ?? null,
                editMode,
                targetLanguage: args.target_language as never,
              },
            )
            const attachment = await attachAsset(result.imageAsset)
            return ok({
              projectId: args.project_id,
              sectionId: args.section_id,
              editMode: result.editMode,
              versionId: result.version.id,
              modelUsed: result.usedModel,
              outputPath: result.imageAsset.filePath,
              attachmentId: attachment?.attachmentId,
            })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_generate_page',
        description:
          'Generate the whole page in the background: hero sections first, then detail sections. Returns a job id immediately — poll with mxpage_job_status. Each image consumes paid image API quota, so confirm with the user before starting a full page.',
        parameters: {
          project_id: { type: 'string', required: true },
          section_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Subset to generate. Defaults to every section without an image.',
          },
          mode: { type: 'string', enum: ['missing', 'all'], description: 'missing (default) skips sections that already have an image.' },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args, exec: ExecContext) {
          try {
            const projectId = args.project_id as string
            const mode = (args.mode as string | undefined) ?? 'missing'
            let sectionIds = args.section_ids as string[] | undefined

            if (!sectionIds?.length) {
              const sections = await host.repository.section.list(projectId)
              sectionIds = sections
                .filter((section) => (mode === 'all' ? true : !section.currentImageAssetId))
                .sort((a, b) => a.order - b.order)
                .map((section) => section.id)
            }
            if (sectionIds.length === 0) return fail('MXPAGE_STATE', 'nothing to generate')
            if (exec.signal?.aborted) return fail('MXPAGE_CANCELLED', 'canceled before start')

            const total = sectionIds.length
            const handle = runtime.runner.start({
              kind: 'mxpage_page',
              label: `Generate ${total} section(s)`,
              owner: projectId,
              async run(runCtx) {
                let done = 0
                for (const sectionId of sectionIds!) {
                  if (runCtx.signal.aborted) break
                  await runCtx.progress.patch({
                    currentSectionId: sectionId,
                    completedItems: done,
                    totalItems: total,
                    heartbeatAt: new Date().toISOString(),
                  })
                  await generation.generateSectionImage(projectId, sectionId)
                  done += 1
                }
                return { projectId, completed: done, total }
              },
            })

            return ok({ kind: 'background', jobId: handle.id, total })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_job_status',
        description: 'Check a background page-generation job started by mxpage_generate_page.',
        parameters: { job_id: { type: 'string', required: true } },
        output: { schema: objectSchema, render: renderJson },
        async execute(args) {
          const jobId = args.job_id as string
          const handle = runtime.runner.get?.(jobId)
          if (handle) return ok({ jobId, state: handle.cancelled ? 'stopping' : 'running' })

          // Not live: either finished, or the plugin restarted and the queue is gone.
          const persisted = await host.repository.task.get(jobId)
          if (!persisted) return fail('MXPAGE_NOT_FOUND', `unknown job ${jobId}`)
          return ok({
            jobId,
            state: persisted.status.toLowerCase(),
            progress: persisted.outputPayload ?? null,
            error: persisted.errorMessage ?? null,
          })
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_job_cancel',
        description: 'Cancel a running mxpage_generate_page job. Sections already generated stay on disk.',
        parameters: { job_id: { type: 'string', required: true } },
        output: { schema: objectSchema, render: renderJson },
        async execute(args) {
          const jobId = args.job_id as string
          const handle = runtime.runner.get?.(jobId)
          if (handle) {
            handle.cancel('canceled by tool')
            return ok({ jobId, cancelled: true })
          }
          const persisted = await host.repository.task.get(jobId)
          if (persisted && (persisted.status === 'RUNNING' || persisted.status === 'PENDING')) {
            await tasks.cancelTask(jobId)
            return ok({ jobId, cancelled: true })
          }
          return fail('MXPAGE_NOT_FOUND', `no running job ${jobId}`)
        },
      }),
    ),
  )

  // -- export ----------------------------------------------------------------

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_export_page',
        description:
          'Export a project as a ZIP (00-头图/ + 01-详情页/ + export-manifest.json) or as raw project JSON.',
        parameters: {
          project_id: { type: 'string', required: true },
          format: { type: 'string', enum: ['zip', 'json'], description: 'Defaults to zip.' },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args) {
          try {
            const projectId = args.project_id as string
            if (((args.format as string | undefined) ?? 'zip') === 'json') {
              const detail = await host.repository.project.getDetail(projectId)
              if (!detail) return fail('MXPAGE_NOT_FOUND', `unknown project ${projectId}`)
              return ok({ projectId, format: 'json', project: detail })
            }
            const archive = await exportService.buildImageArchive(projectId)
            return ok({ projectId, format: 'zip', archive })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  // -- xiaohongshu four-step flow -------------------------------------------

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_xiaohongshu_plan',
        description:
          'Step 1 of the Xiaohongshu carousel flow: plan N pages (title, body copy, per-page image prompt) from a topic. Falls back to a fully local Chinese template plan when the model is unavailable.',
        parameters: {
          topic: { type: 'string', required: true, description: 'Post topic or product angle.' },
          image_count: { type: 'integer', description: '3–8 pages. Defaults to 5.' },
          aspect_ratio: { type: 'string', enum: [...ASPECT_ENUM], description: 'Defaults to 3:4.' },
          reference_image_paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Up to 4 reference images by absolute path.',
          },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args, exec: ExecContext) {
          try {
            const paths = (args.reference_image_paths as string[] | undefined) ?? []
            const images: string[] = []
            for (const source of paths.slice(0, 4)) {
              const buffer = await readLocalFile(source)
              images.push(`data:${guessMime(source)};base64,${buffer.toString('base64')}`)
            }
            const plan = await xiaohongshu.planXiaohongshuPost({
              topic: args.topic as string,
              imageCount: clamp(args.image_count as number | undefined, 3, 8, 5),
              imageAspectRatio: ((args.aspect_ratio as string | undefined) ?? '3:4') as
                | '1:1'
                | '3:4'
                | '9:16',
              images,
              signal: exec.signal,
            })
            return ok({ plan })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_xiaohongshu_generate',
        description:
          'Step 3 of the Xiaohongshu flow: generate every carousel image from a plan produced by mxpage_xiaohongshu_plan. Each page runs the Visual Prompt Agent first. Returns one image per page.',
        parameters: {
          plan_json: {
            type: 'string',
            required: true,
            description: 'The `plan` object from mxpage_xiaohongshu_plan, JSON-encoded.',
          },
          aspect_ratio: { type: 'string', enum: [...ASPECT_ENUM] },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args, exec: ExecContext) {
          try {
            const plan = JSON.parse(args.plan_json as string)
            const images = await xiaohongshu.generateXiaohongshuImages(plan, undefined, {
              imageAspectRatio: (args.aspect_ratio as '1:1' | '3:4' | '9:16' | undefined) ?? undefined,
              signal: exec.signal,
            })
            return ok({
              pages: images.map((page) => ({
                pageNumber: page.pageNumber,
                title: page.title,
                model: page.model,
                revisedPrompt: page.revisedPrompt,
                // data URL (b64_json) or a provider URL — surfaced verbatim so it
                // can be passed straight to mxpage_xiaohongshu_edit.
                imageUrl: page.imageUrl,
              })),
            })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_xiaohongshu_edit',
        description:
          'Step 4 of the Xiaohongshu flow: edit one carousel image (re-letter, restyle, fix details) while keeping the rest of the composition.',
        parameters: {
          image_url: {
            type: 'string',
            required: true,
            description: 'A data URL or provider URL returned by mxpage_xiaohongshu_generate.',
          },
          prompt: { type: 'string', required: true, description: 'What to change.' },
          aspect_ratio: { type: 'string', enum: [...ASPECT_ENUM] },
        },
        output: { schema: objectSchema, render: renderJson },
        async execute(args, exec: ExecContext) {
          try {
            const edited = await xiaohongshu.editXiaohongshuImage({
              imageUrl: args.image_url as string,
              prompt: args.prompt as string,
              imageAspectRatio: (args.aspect_ratio as '1:1' | '3:4' | '9:16' | undefined) ?? undefined,
              signal: exec.signal,
            })
            return ok({ edited })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  // -- diagnostics -----------------------------------------------------------

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'mxpage_channels',
        description:
          'Diagnose the MxPage channel configuration: which channel is active, its model catalog, and whether any image-capable model was found. Use this first when generation fails.',
        parameters: {},
        output: { schema: objectSchema, render: renderJson },
        async execute() {
          try {
            const resolved = await host.provider.resolve({ operation: 'diagnostics' })
            const imageModels = resolved.models.filter(
              (model) => model.capabilities.image_gen || model.capabilities.image_edit,
            )
            const visionModels = resolved.models.filter((model) => model.capabilities.vision)
            return ok({
              channel: { id: resolved.id, label: resolved.label, baseUrl: resolved.baseUrl },
              modelCount: resolved.models.length,
              imageModels: imageModels.map((model) => model.modelId),
              visionModels: visionModels.map((model) => model.modelId),
              storeRoot,
              warning:
                imageModels.length === 0
                  ? 'No image-capable model found. Capability is inferred from the model name because upstream skips real endpoint probing to avoid burning image quota, so a gateway that lists a model it cannot serve is discovered only by failing.'
                  : null,
            })
          } catch (error) {
            return toFailure(error)
          }
        },
      }),
    ),
  )

  return disposers
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || 'image.png'
}

function guessMime(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/png'
}

async function readLocalFile(filePath: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises')
  return readFile(filePath)
}
