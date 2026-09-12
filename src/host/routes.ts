/**
 * Host-side HTTP API for the browser panel.
 *
 * The panel is a browser surface, so it needs a transport. Tools are the model's
 * channel; these routes are the human's. They are registered on the DSH
 * `webServer` service and fenced to loopback requests, mirroring
 * `@dickpy/dsh-imagegen`'s bridge.
 *
 * Every response uses the `{ ok: true, ... }` / `{ ok: false, code, message }`
 * envelope the client's `readEnvelope` expects.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import type { Config } from '../config.ts'
import { ROUTES } from '../shared/routes.ts'
import { redactSecrets } from '../util/redact.ts'
import type { MxpageRuntime } from './index.ts'

export { ROUTES }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

/** Loopback fence + method check. Returns false when the response is already sent. */
function guard(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (!isLoopback(req)) {
    writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' })
    return false
  }
  if (req.method !== method) {
    writeJson(res, 405, {
      ok: false,
      code: 'method-not-allowed',
      message: `method not allowed: ${req.method}`,
    })
    return false
  }
  return true
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.byteLength
    // Uploads arrive as base64 in JSON; 64 MiB covers a 48 MiB image.
    if (total > 64 * 1024 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Wraps a handler so a thrown error becomes a code envelope instead of a 500. */
function envelope(
  handler: (body: Record<string, unknown>, req: IncomingMessage) => Promise<Record<string, unknown>>,
) {
  return async (req: IncomingMessage, res: ServerResponse, method: string): Promise<void> => {
    if (!guard(req, res, method)) return
    try {
      const body = method === 'GET' ? {} : await readJsonBody(req)
      writeJson(res, 200, { ok: true, ...(await handler(body, req)) })
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error))
      const code = /429|quota|额度/i.test(message)
        ? 'MXPAGE_HTTP_429'
        : /401|403|key|密钥|未配置/i.test(message)
          ? 'MXPAGE_HTTP_401'
          : /not found|不存在/i.test(message)
            ? 'MXPAGE_NOT_FOUND'
            : /cancel|取消/i.test(message)
              ? 'MXPAGE_CANCELLED'
              : 'MXPAGE_ERROR'
      writeJson(res, 200, { ok: false, code, message })
    }
  }
}

function query(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export interface RouteDeps {
  runtime: MxpageRuntime
  config: Config
  /** Maps a storage-relative path to a browser-reachable URL. */
  imageUrl: (relPath: string) => string
}

export function makeMxpageRoutes(deps: RouteDeps): WebRoute[] {
  const { runtime, config, imageUrl } = deps
  const { host, analysis, planner, generation, exportService, xiaohongshu, assets } = runtime

  /** Panel-facing projection: storage paths become browser URLs. */
  async function projectView(projectId: string) {
    const detail = await host.repository.project.getDetail(projectId)
    if (!detail) throw new Error(`project not found: ${projectId}`)
    const main = detail.assets.find((asset) => asset.isMain) ?? detail.assets[0] ?? null
    return {
      project: {
        id: detail.id,
        name: detail.name,
        status: detail.status,
        platform: detail.platform,
        style: detail.style,
        modelSnapshot: detail.modelSnapshot,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
      },
      analysis: detail.analysis?.normalizedResult ?? null,
      coverImageUrl: main ? imageUrl(main.filePath) : null,
      assets: detail.assets.map((asset) => ({
        id: asset.id,
        type: asset.type,
        fileName: asset.fileName,
        isMain: asset.isMain,
        sortOrder: asset.sortOrder,
        url: imageUrl(asset.filePath),
      })),
      sections: detail.sections.map((section) => ({
        id: section.id,
        sectionKey: section.sectionKey,
        type: section.type,
        title: section.title,
        goal: section.goal,
        copy: section.copy,
        visualPrompt: section.visualPrompt,
        order: section.order,
        status: section.status,
        editableData: section.editableData ?? null,
        imageUrl: section.currentImageAssetId
          ? imageUrl(
              detail.assets.find((asset) => asset.id === section.currentImageAssetId)?.filePath ??
                '',
            )
          : null,
        versions: section.versions.map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          isActive: version.isActive,
          createdAt: version.createdAt,
          imageUrl: version.imageAssetId
            ? imageUrl(
                detail.assets.find((asset) => asset.id === version.imageAssetId)?.filePath ?? '',
              )
            : null,
        })),
      })),
    }
  }

  return [
    // -- projects -----------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.projects,
      handler: envelope(async () => {
        const list = await host.repository.project.list({ limit: 200 })
        const views = await Promise.all(
          list.map(async (project) => {
            const main = (await host.repository.asset.list({ projectId: project.id })).find(
              (asset) => asset.isMain,
            )
            return {
              id: project.id,
              name: project.name,
              status: project.status,
              platform: project.platform,
              style: project.style,
              updatedAt: project.updatedAt,
              coverImageUrl: main ? imageUrl(main.filePath) : null,
            }
          }),
        )
        return { projects: views }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.projectCreate,
      handler: envelope(async (body) => {
        const name = asString(body.name) ?? 'untitled'
        const files = Array.isArray(body.files) ? (body.files as Array<Record<string, unknown>>) : []
        if (files.length < 1 || files.length > 10) {
          throw new Error('supply 1–10 product photos')
        }
        const project = await host.repository.project.create({
          name,
          platform: asString(body.platform) ?? config.defaultPlatform,
          style: asString(body.style) ?? config.defaultStyle,
        })
        let index = 0
        for (const file of files) {
          const fileName = asString(file.fileName)
          const base64Data = asString(file.base64Data)
          if (!fileName || !base64Data) throw new Error('each file needs fileName and base64Data')
          await assets.saveUploadAsset({
            projectId: project.id,
            type: index === 0 ? 'MAIN' : 'REFERENCE',
            fileName,
            mimeType: asString(file.mimeType) ?? 'image/png',
            fileBuffer: Buffer.from(base64Data.replace(/^data:[^;]+;base64,/, ''), 'base64'),
            sortOrder: index,
            isMain: index === 0,
          })
          index += 1
        }
        await host.repository.project.mergeModelSnapshot(project.id, {
          previewConfig: {
            heroImageCount: config.defaultHeroCount,
            detailSectionCount: config.defaultDetailCount,
            imageAspectRatio: config.defaultDetailAspectRatio,
            contentLanguage: config.defaultLanguage,
          },
        })
        return { projectId: project.id, assetCount: index }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.project,
      handler: envelope(async (_body, req) => {
        const id = query(req).get('id')
        if (!id) throw new Error('id is required')
        return projectView(id)
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.upload,
      handler: envelope(async (body) => {
        const projectId = asString(body.projectId)
        const fileName = asString(body.fileName)
        const base64Data = asString(body.base64Data)
        if (!projectId || !fileName || !base64Data) {
          throw new Error('projectId, fileName and base64Data are required')
        }
        const role = (asString(body.role) ?? 'reference').toUpperCase()
        const count = await host.repository.asset.count(projectId)
        if (count >= 10) throw new Error('max 10 assets per project')
        const bytes = Buffer.from(base64Data.replace(/^data:[^;]+;base64,/, ''), 'base64')
        const asset = await assets.saveUploadAsset({
          projectId,
          type: role as 'MAIN' | 'ANGLE' | 'DETAIL' | 'REFERENCE',
          fileName,
          mimeType: asString(body.mimeType) ?? 'image/png',
          fileBuffer: bytes,
          sortOrder: count,
          isMain: role === 'MAIN',
        })
        if (role === 'MAIN') await host.repository.asset.setMain(projectId, asset.id)
        return { assetId: asset.id, url: imageUrl(asset.filePath) }
      }),
    },

    // -- pipeline -----------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.analyze,
      handler: envelope(async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        const result = await analysis.analyzeProject(projectId, asString(body.model) ?? null)
        return { analysis: result.normalizedResult }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.plan,
      handler: envelope(async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        const previewConfig = (body.previewConfig ?? {}) as Record<string, unknown>
        const result = await planner.planSections(projectId, {
          modelId: asString(body.model) ?? null,
          previewConfig: {
            heroImageCount:
              asNumber(previewConfig.heroImageCount) ?? config.defaultHeroCount,
            detailSectionCount:
              asNumber(previewConfig.detailSectionCount) ?? config.defaultDetailCount,
            imageAspectRatio: (asString(previewConfig.imageAspectRatio) ??
              config.defaultDetailAspectRatio) as '3:4' | '9:16',
            contentLanguage: (asString(previewConfig.contentLanguage) ??
              config.defaultLanguage) as never,
          },
          autoDecideCounts: body.autoDecideCounts === true,
        })
        return {
          visualStyleGuide: result.visualStyleGuide,
          previewConfig: result.previewConfig,
          fallbackMode: result.fallbackMode ?? null,
        }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.styleGuide,
      handler: envelope(async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        const result = await planner.regenerateVisualStyleGuide(
          projectId,
          asString(body.model) ?? null,
        )
        return { visualStyleGuide: result.visualStyleGuide }
      }),
    },

    // -- sections -----------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.section,
      handler: envelope(async (body) => {
        const sectionId = asString(body.sectionId)
        if (!sectionId) throw new Error('sectionId is required')
        const patch = (body.patch ?? {}) as Record<string, unknown>
        const section = await planner.updateSection(sectionId, patch)
        return { section }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.sectionCreate,
      handler: envelope(async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        const section = await planner.createSection(projectId, {
          type: asString(body.type) ?? 'custom',
          title: asString(body.title) ?? '自定义模块',
          goal: asString(body.goal) ?? '',
          copy: asString(body.copy) ?? '',
          visualPrompt: asString(body.visualPrompt) ?? '',
        })
        return { section }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.sectionDelete,
      handler: envelope(async (body) => {
        const sectionId = asString(body.sectionId)
        if (!sectionId) throw new Error('sectionId is required')
        await planner.deleteSection(sectionId)
        return {}
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.reorder,
      handler: envelope(async (body) => {
        const projectId = asString(body.projectId)
        const ordered = body.orderedSectionIds
        if (!projectId || !Array.isArray(ordered)) {
          throw new Error('projectId and orderedSectionIds are required')
        }
        await planner.reorderSections(projectId, ordered as string[])
        return {}
      }),
    },

    // -- generation ---------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.generate,
      handler: envelope(async (body) => {
        const projectId = asString(body.projectId)
        const sectionId = asString(body.sectionId)
        if (!projectId || !sectionId) throw new Error('projectId and sectionId are required')
        const invoke =
          body.regenerate === true ? generation.regenerateSectionImage : generation.generateSectionImage
        const result = await invoke(projectId, sectionId, asString(body.model) ?? null)
        return {
          versionId: result.version.id,
          versionNumber: result.version.versionNumber,
          modelUsed: result.usedModel,
          generationMode: result.generationMode,
          imageUrl: imageUrl(result.imageAsset.filePath),
        }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.edit,
      handler: envelope(async (body) => {
        const projectId = asString(body.projectId)
        const sectionId = asString(body.sectionId)
        const editMode = asString(body.editMode) as 'repaint' | 'enhance' | 'translate' | undefined
        if (!projectId || !sectionId || !editMode) {
          throw new Error('projectId, sectionId and editMode are required')
        }
        if (editMode === 'translate' && !asString(body.targetLanguage)) {
          throw new Error('targetLanguage is required for mode=translate')
        }
        const result = await generation.editSectionImage(projectId, sectionId, {
          preferredModelId: asString(body.model) ?? null,
          editMode,
          targetLanguage: asString(body.targetLanguage) as never,
        })
        return {
          versionId: result.version.id,
          modelUsed: result.usedModel,
          editMode: result.editMode,
          imageUrl: imageUrl(result.imageAsset.filePath),
        }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.generatePage,
      handler: envelope(async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        const mode = asString(body.mode) ?? 'missing'
        const sections = await host.repository.section.list(projectId)
        const sectionIds = sections
          .filter((section) => (mode === 'all' ? true : !section.currentImageAssetId))
          .sort((a, b) => a.order - b.order)
          .map((section) => section.id)
        if (sectionIds.length === 0) throw new Error('nothing to generate')

        const total = sectionIds.length
        const handle = runtime.runner.start({
          kind: 'mxpage_page',
          label: `Generate ${total} section(s)`,
          owner: projectId,
          async run(ctx) {
            let done = 0
            for (const sectionId of sectionIds) {
              if (ctx.signal.aborted) break
              await ctx.progress.patch({
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
        return { jobId: handle.id, total }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.job,
      handler: envelope(async (_body, req) => {
        const jobId = query(req).get('id')
        if (!jobId) throw new Error('id is required')
        const handle = runtime.runner.get?.(jobId)
        if (handle) return { state: handle.cancelled ? 'stopping' : 'running', progress: null }
        const persisted = await host.repository.task.get(jobId)
        return {
          state: persisted?.status.toLowerCase() ?? 'unknown',
          progress: persisted?.outputPayload ?? null,
          error: persisted?.errorMessage ?? null,
        }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.jobCancel,
      handler: envelope(async (body) => {
        const jobId = asString(body.jobId)
        if (!jobId) throw new Error('jobId is required')
        const handle = runtime.runner.get?.(jobId)
        if (handle) {
          handle.cancel('canceled from panel')
          return { cancelled: true }
        }
        await runtime.tasks.cancelTask(jobId)
        return { cancelled: true }
      }),
    },

    // -- versions -----------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.versions,
      handler: envelope(async (_body, req) => {
        const sectionId = query(req).get('sectionId')
        if (!sectionId) throw new Error('sectionId is required')
        const list = await generation.listSectionVersions(sectionId)
        return {
          versions: list.map((version) => ({
            id: version.id,
            versionNumber: version.versionNumber,
            isActive: version.isActive,
            createdAt: version.createdAt,
            imageUrl: version.imageAsset ? imageUrl(version.imageAsset.filePath) : null,
          })),
        }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.versionActivate,
      handler: envelope(async (body) => {
        const sectionId = asString(body.sectionId)
        const versionId = asString(body.versionId)
        if (!sectionId || !versionId) throw new Error('sectionId and versionId are required')
        const version = await generation.activateSectionVersion(sectionId, versionId)
        return {
          versionId: version?.id ?? null,
          imageUrl: version?.imageAsset ? imageUrl(version.imageAsset.filePath) : null,
        }
      }),
    },

    // -- export -------------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.export,
      handler: envelope(async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        if (asString(body.format) === 'json') {
          const detail = await host.repository.project.getDetail(projectId)
          return { format: 'json', project: detail }
        }
        const archive = await exportService.buildImageArchive(projectId)
        return {
          format: 'zip',
          fileName: archive.fileName,
          byteLength: archive.byteLength,
          heroImageCount: archive.heroImageCount,
          detailImageCount: archive.detailImageCount,
          zipPath: archive.zipPath,
        }
      }),
    },

    // -- image bytes --------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.image,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const relPath = query(req).get('path') ?? ''
          if (!relPath) {
            writeJson(res, 400, { ok: false, code: 'bad-request', message: 'path is required' })
            return
          }
          const bytes = await assets.readStorageFile(relPath)
          const lower = relPath.toLowerCase()
          const contentType = lower.endsWith('.jpg') || lower.endsWith('.jpeg')
            ? 'image/jpeg'
            : lower.endsWith('.webp')
              ? 'image/webp'
              : lower.endsWith('.svg')
                ? 'image/svg+xml'
                : 'image/png'
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'Content-Length': bytes.byteLength,
          })
          res.end(bytes)
        } catch {
          writeJson(res, 404, { ok: false, code: 'not-found', message: 'image not found' })
        }
      },
    },

    // -- diagnostics --------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.channels,
      handler: envelope(async () => {
        const resolved = await host.provider.resolve({ operation: 'panel-diagnostics' })
        return {
          channel: { id: resolved.id, label: resolved.label, baseUrl: resolved.baseUrl },
          modelCount: resolved.models.length,
          imageModels: resolved.models
            .filter((model) => model.capabilities.image_gen || model.capabilities.image_edit)
            .map((model) => model.modelId),
          textModels: resolved.models
            .filter((model) => model.capabilities.text)
            .map((model) => model.modelId),
          visionModels: resolved.models
            .filter((model) => model.capabilities.vision)
            .map((model) => model.modelId),
          channels: (config.channels ?? []).map((channel) => ({
            id: channel.id,
            label: channel.label ?? channel.id,
            baseUrl: channel.baseUrl,
            disabled: channel.disabled === true,
            hasKey: Boolean(
              (channel.apiKeyEnv ? process.env[channel.apiKeyEnv] : undefined) ?? channel.apiKey,
            ),
            models: channel.models ?? [],
          })),
        }
      }),
    },

    // -- xiaohongshu --------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.xhsPlan,
      handler: envelope(async (body) => {
        const topic = asString(body.topic)
        if (!topic) throw new Error('topic is required')
        const plan = await xiaohongshu.planXiaohongshuPost({
          topic,
          imageCount: asNumber(body.imageCount) ?? 5,
          imageAspectRatio: (asString(body.aspectRatio) ?? '3:4') as '1:1' | '3:4' | '9:16',
        })
        return { plan }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.xhsGenerate,
      handler: envelope(async (body) => {
        const plan = body.plan as never
        if (!plan) throw new Error('plan is required')
        const images = await xiaohongshu.generateXiaohongshuImages(plan, undefined, {
          imageAspectRatio: asString(body.aspectRatio) as '1:1' | '3:4' | '9:16' | undefined,
        })
        return { pages: images }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.xhsEdit,
      handler: envelope(async (body) => {
        const imageUrlValue = asString(body.imageUrl)
        const prompt = asString(body.prompt)
        if (!imageUrlValue || !prompt) throw new Error('imageUrl and prompt are required')
        const edited = await xiaohongshu.editXiaohongshuImage({
          imageUrl: imageUrlValue,
          prompt,
          imageAspectRatio: asString(body.aspectRatio) as '1:1' | '3:4' | '9:16' | undefined,
        })
        return { edited }
      }),
    },
  ] as WebRoute[]
}
