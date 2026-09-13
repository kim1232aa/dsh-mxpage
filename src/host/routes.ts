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

import { OpenAICompatibleAdapter } from '../core/ai/adapters/openai-compatible.ts'
import { normalizeDetectedModels } from '../core/ai/capability-detector.ts'
import { recommendDefaultModels } from '../core/ai/model-matcher.ts'
import {
  humanizeEntry,
  summarizeUsage,
  type QuotaState,
} from '../core/monitor/api-usage.ts'
import type { UsageCategory } from '../core/ports/logger.ts'
import type { Config } from '../config.ts'
import { ROUTES } from '../shared/routes.ts'
import { redactSecrets } from '../util/redact.ts'
import type { MxpageRuntime } from './index.ts'
import { readChannelKey } from './provider-resolver.ts'
import {
  clearUsageEntries,
  deleteUsageEntry,
  readUsageEntries,
} from './usage-monitor.ts'

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

/**
 * Wraps a handler so a thrown error becomes a code envelope instead of a 500.
 *
 * `method` is bound at REGISTRATION time (a closure over the expected verb),
 * not read from the runtime call — the real `WebRoute.handler` signature is
 * `(req, res) => void | Promise<void>` with no third parameter. A prior
 * version accepted `method` as the handler's third argument, which the host
 * never supplies (it is always `undefined`), so `guard()`'s `req.method !==
 * method` check was permanently true and EVERY route always answered
 * `method not allowed`. Caught by a live GUI run, not by the type checker,
 * because `WebRoute[]` is only asserted with `as WebRoute[]` at the end of
 * this file rather than satisfied structurally.
 */
function envelope(
  method: 'GET' | 'POST',
  handler: (body: Record<string, unknown>, req: IncomingMessage) => Promise<Record<string, unknown>>,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
  // Do NOT destructure `runtime.host` / `runtime.analysis` / … here.
  // `src/index.ts` wraps `runtime` and `config` in Proxies so a settings-panel
  // edit can swap the live runtime without re-registering routes. Property
  // access must happen inside each handler (i.e. on every request), not once
  // at registration — a prior version captured the inner fields here and the
  // panel kept talking to a stale ProviderResolver after the user saved a
  // channel.
  const { runtime, config, imageUrl } = deps

  /** Panel-facing projection: storage paths become browser URLs. */
  async function projectView(projectId: string) {
    const detail = await runtime.host.repository.project.getDetail(projectId)
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
       handler: envelope('POST', async () => {
        const list = await runtime.host.repository.project.list({ limit: 200 })
        const views = await Promise.all(
          list.map(async (project) => {
            const main = (await runtime.host.repository.asset.list({ projectId: project.id })).find(
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
       handler: envelope('POST', async (body) => {
        const name = asString(body.name) ?? 'untitled'
        const files = Array.isArray(body.files) ? (body.files as Array<Record<string, unknown>>) : []
        if (files.length < 1 || files.length > 10) {
          throw new Error('supply 1–10 product photos')
        }
        const project = await runtime.host.repository.project.create({
          name,
          platform: asString(body.platform) ?? config.defaultPlatform,
          style: asString(body.style) ?? config.defaultStyle,
        })
        let index = 0
        for (const file of files) {
          const fileName = asString(file.fileName)
          const base64Data = asString(file.base64Data)
          if (!fileName || !base64Data) throw new Error('each file needs fileName and base64Data')
          await runtime.assets.saveUploadAsset({
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
        await runtime.host.repository.project.mergeModelSnapshot(project.id, {
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
       handler: envelope('GET', async (_body, req) => {
        const id = query(req).get('id')
        if (!id) throw new Error('id is required')
        return projectView(id)
      }),
    },
    {
      // Upstream `PATCH /api/projects/[id]`: rename + platform/style edits.
      kind: 'exact',
      path: ROUTES.projectUpdate,
       handler: envelope('POST', async (body) => {
        const id = asString(body.id)
        if (!id) throw new Error('id is required')
        const project = await runtime.host.repository.project.update(id, {
          name: asString(body.name),
          platform: asString(body.platform),
          style: asString(body.style),
          description: asString(body.description) ?? null,
        })
        return {
          project: {
            id: project.id,
            name: project.name,
            platform: project.platform,
            style: project.style,
            status: project.status,
          },
        }
      }),
    },
    {
      // Upstream `DELETE /api/projects/[id]`: record + workspace files.
      kind: 'exact',
      path: ROUTES.projectDelete,
       handler: envelope('POST', async (body) => {
        const id = asString(body.id)
        if (!id) throw new Error('id is required')
        const existing = await runtime.host.repository.project.get(id)
        if (!existing) throw new Error(`project not found: ${id}`)
        await runtime.host.repository.project.delete(id)
        await runtime.assets.removeProjectDirs(id).catch((error: unknown) => {
          runtime.logger.warn('[mxpage] project files cleanup failed', {
            projectId: id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return { deleted: true }
      }),
    },
    {
      // Upstream `POST /api/assets/[id]/reorder`.
      kind: 'exact',
      path: ROUTES.assetsReorder,
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        const ordered = body.orderedAssetIds
        if (!projectId || !Array.isArray(ordered)) {
          throw new Error('projectId and orderedAssetIds are required')
        }
        let index = 0
        for (const assetId of ordered as string[]) {
          await runtime.host.repository.asset.updateSortOrder(assetId, index)
          index += 1
        }
        return { reordered: index }
      }),
    },
    {
      // Upstream `POST /api/assets/[id]/set-main`.
      kind: 'exact',
      path: ROUTES.assetSetMain,
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        const assetId = asString(body.assetId)
        if (!projectId || !assetId) throw new Error('projectId and assetId are required')
        await runtime.host.repository.asset.setMain(projectId, assetId)
        return {}
      }),
    },
    {
      // Upstream `DELETE /api/assets/[id]`: refuse while a section/version points at it.
      kind: 'exact',
      path: ROUTES.assetDelete,
       handler: envelope('POST', async (body) => {
        const assetId = asString(body.assetId)
        if (!assetId) throw new Error('assetId is required')
        const referenced = await runtime.host.repository.asset.isReferenced(assetId)
        if (referenced) {
          throw new Error('素材正被分区或版本引用，请先切换分区图片后再删除。')
        }
        const removed = await runtime.assets.deleteAssetRecord(assetId)
        if (!removed) throw new Error(`asset not found: ${assetId}`)
        return { deleted: true }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.upload,
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        const fileName = asString(body.fileName)
        const base64Data = asString(body.base64Data)
        if (!projectId || !fileName || !base64Data) {
          throw new Error('projectId, fileName and base64Data are required')
        }
        const role = (asString(body.role) ?? 'reference').toUpperCase()
        const count = await runtime.host.repository.asset.count(projectId)
        if (count >= 10) throw new Error('max 10 assets per project')
        const bytes = Buffer.from(base64Data.replace(/^data:[^;]+;base64,/, ''), 'base64')
        const asset = await runtime.assets.saveUploadAsset({
          projectId,
          type: role as 'MAIN' | 'ANGLE' | 'DETAIL' | 'REFERENCE',
          fileName,
          mimeType: asString(body.mimeType) ?? 'image/png',
          fileBuffer: bytes,
          sortOrder: count,
          isMain: role === 'MAIN',
        })
        if (role === 'MAIN') await runtime.host.repository.asset.setMain(projectId, asset.id)
        return { assetId: asset.id, url: imageUrl(asset.filePath) }
      }),
    },

    // -- pipeline -----------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.analyze,
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        const result = await runtime.analysis.analyzeProject(projectId, asString(body.model) ?? null)
        return { analysis: result.normalizedResult }
      }),
    },
    {
      // Upstream analysis page saves edited structured fields back to the
      // ProductAnalysis row. Raw and normalized stay identical here because
      // the panel edits the normalized projection directly.
      kind: 'exact',
      path: ROUTES.analysisSave,
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        const analysis = body.analysis
        if (!projectId || !analysis || typeof analysis !== 'object') {
          throw new Error('projectId and analysis are required')
        }
        await runtime.host.repository.analysis.upsert(projectId, {
          rawResult: analysis,
          normalizedResult: analysis,
        })
        return { saved: true }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.plan,
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        const previewConfig = (body.previewConfig ?? {}) as Record<string, unknown>
        const result = await runtime.planner.planSections(projectId, {
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
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        const result = await runtime.planner.regenerateVisualStyleGuide(
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
       handler: envelope('POST', async (body) => {
        const sectionId = asString(body.sectionId)
        if (!sectionId) throw new Error('sectionId is required')
        const patch = (body.patch ?? {}) as Record<string, unknown>
        const section = await runtime.planner.updateSection(sectionId, patch)
        return { section }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.sectionCreate,
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        const section = await runtime.planner.createSection(projectId, {
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
       handler: envelope('POST', async (body) => {
        const sectionId = asString(body.sectionId)
        if (!sectionId) throw new Error('sectionId is required')
        await runtime.planner.deleteSection(sectionId)
        return {}
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.reorder,
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        const ordered = body.orderedSectionIds
        if (!projectId || !Array.isArray(ordered)) {
          throw new Error('projectId and orderedSectionIds are required')
        }
        await runtime.planner.reorderSections(projectId, ordered as string[])
        return {}
      }),
    },

    // -- generation ---------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.generate,
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        const sectionId = asString(body.sectionId)
        if (!projectId || !sectionId) throw new Error('projectId and sectionId are required')
        const invoke =
          body.regenerate === true ? runtime.generation.regenerateSectionImage : runtime.generation.generateSectionImage
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
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        const sectionId = asString(body.sectionId)
        const editMode = asString(body.editMode) as 'repaint' | 'enhance' | 'translate' | undefined
        if (!projectId || !sectionId || !editMode) {
          throw new Error('projectId, sectionId and editMode are required')
        }
        if (editMode === 'translate' && !asString(body.targetLanguage)) {
          throw new Error('targetLanguage is required for mode=translate')
        }
        const result = await runtime.generation.editSectionImage(projectId, sectionId, {
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
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        const mode = asString(body.mode) ?? 'missing'
        const sections = await runtime.host.repository.section.list(projectId)
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
              await runtime.generation.generateSectionImage(projectId, sectionId)
              done += 1
            }
            return { projectId, completed: done, total }
          },
        })
        return { jobId: handle.id, total }
      }),
    },
    {
      // Upstream `POST /api/projects/[id]/translate-page`: a background task
      // that translate-edits every section which already has an image.
      kind: 'exact',
      path: ROUTES.translatePage,
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        const targetLanguage = asString(body.targetLanguage)
        if (!projectId || !targetLanguage) {
          throw new Error('projectId and targetLanguage are required')
        }
        const sections = await runtime.host.repository.section.list(projectId)
        const targets = sections
          .filter((section) => section.currentImageAssetId)
          .sort((a, b) => a.order - b.order)
        if (targets.length === 0) throw new Error('没有已出图的分区可翻译')

        const total = targets.length
        const handle = runtime.runner.start({
          kind: 'mxpage_translate',
          label: `Translate ${total} section(s) → ${targetLanguage}`,
          owner: projectId,
          async run(ctx) {
            let done = 0
            let failed = 0
            for (const section of targets) {
              if (ctx.signal.aborted) break
              await ctx.progress.patch({
                currentSectionId: section.id,
                completedItems: done,
                failedItems: failed,
                totalItems: total,
                targetLanguage,
                heartbeatAt: new Date().toISOString(),
              })
              try {
                await runtime.generation.editSectionImage(projectId, section.id, {
                  editMode: 'translate',
                  targetLanguage: targetLanguage as never,
                })
                done += 1
              } catch (error) {
                failed += 1
                runtime.logger.warn('[mxpage] translate section failed', {
                  projectId,
                  sectionId: section.id,
                  error: error instanceof Error ? error.message : String(error),
                })
              }
            }
            return { projectId, completed: done, failed, total, targetLanguage }
          },
        })
        return { jobId: handle.id, total }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.job,
       handler: envelope('GET', async (_body, req) => {
        const jobId = query(req).get('id')
        if (!jobId) throw new Error('id is required')
        const handle = runtime.runner.get?.(jobId)
        if (handle) return { state: handle.cancelled ? 'stopping' : 'running', progress: null }
        // Settled jobs keep no live handle; ask the runner for its terminal
        // state before falling back to the task row. Without this, completed
        // page-generation jobs (whose ids exist only in the runner) polled as
        // `unknown` and the panel reported "生成结束：未知".
        const runnerState = runtime.runner.status?.(jobId)
        if (runnerState && runnerState !== 'unknown') {
          return { state: runnerState, progress: null, error: null }
        }
        const persisted = await runtime.host.repository.task.get(jobId)
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
       handler: envelope('POST', async (body) => {
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

    // -- task history + retry -------------------------------------------------
    {
      // Upstream `/history`: recent workflow tasks, newest first.
      kind: 'exact',
      path: ROUTES.tasks,
       handler: envelope('GET', async (_body, req) => {
        const params = query(req)
        const projectId = params.get('projectId')
        const limit = Number(params.get('limit') ?? 50) || 50
        // Tasks are project-scoped in the repository; the panel history view
        // aggregates across projects by listing each project's tasks.
        const projects = projectId
          ? [{ id: projectId }]
          : await runtime.host.repository.project.list({ limit: 100, includeSystem: true })
        const all = (
          await Promise.all(
            projects.map((project) => runtime.host.repository.task.list(project.id, limit)),
          )
        )
          .flat()
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, limit)
        return {
          tasks: all.map((task) => ({
            id: task.id,
            projectId: task.projectId,
            sectionId: task.sectionId,
            taskType: task.taskType,
            status: task.status,
            errorMessage: task.errorMessage,
            inputPayload: task.inputPayload,
            outputPayload: task.outputPayload,
            createdAt: task.createdAt,
            completedAt: task.completedAt,
          })),
        }
      }),
    },
    {
      // Upstream `POST /api/tasks/[taskId]/retry`: re-dispatch the same work.
      kind: 'exact',
      path: ROUTES.taskRetry,
       handler: envelope('POST', async (body) => {
        const taskId = asString(body.taskId)
        if (!taskId) throw new Error('taskId is required')
        const task = await runtime.host.repository.task.get(taskId)
        if (!task) throw new Error(`task not found: ${taskId}`)
        if (task.status === 'RUNNING' || task.status === 'PENDING') {
          throw new Error('任务仍在进行中，请先取消再重试。')
        }
        const input = (task.inputPayload ?? {}) as Record<string, unknown>

        if (
          (task.taskType === 'GENERATE' || task.taskType === 'REGENERATE') &&
          task.sectionId
        ) {
          const result = await runtime.generation.generateSectionImage(
            task.projectId,
            task.sectionId,
          )
          return {
            retried: true,
            taskType: task.taskType,
            versionId: result.version.id,
            imageUrl: imageUrl(result.imageAsset.filePath),
          }
        }

        if (task.taskType === 'TRANSLATE_PAGE') {
          const targetLanguage = asString(input.targetLanguage)
          if (!targetLanguage) throw new Error('原任务缺少 targetLanguage，无法重试')
          const sections = await runtime.host.repository.section.list(task.projectId)
          const targets = sections
            .filter((section) => section.currentImageAssetId)
            .sort((a, b) => a.order - b.order)
          if (targets.length === 0) throw new Error('没有已出图的分区可翻译')
          const total = targets.length
          const handle = runtime.runner.start({
            kind: 'mxpage_translate',
            label: `Translate ${total} section(s) → ${targetLanguage}`,
            owner: task.projectId,
            async run(ctx) {
              let done = 0
              for (const section of targets) {
                if (ctx.signal.aborted) break
                await ctx.progress.patch({
                  currentSectionId: section.id,
                  completedItems: done,
                  totalItems: total,
                  heartbeatAt: new Date().toISOString(),
                })
                try {
                  await runtime.generation.editSectionImage(task.projectId, section.id, {
                    editMode: 'translate',
                    targetLanguage: targetLanguage as never,
                  })
                } catch (error) {
                  runtime.logger.warn('[mxpage] translate retry section failed', {
                    projectId: task.projectId,
                    sectionId: section.id,
                    error: error instanceof Error ? error.message : String(error),
                  })
                }
                done += 1
              }
              return { projectId: task.projectId, completed: done, total, targetLanguage }
            },
          })
          return { retried: true, taskType: task.taskType, jobId: handle.id, total }
        }

        throw new Error(`任务类型 ${task.taskType} 暂不支持在面板重试`)
      }),
    },

    // -- versions -----------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.versions,
       handler: envelope('GET', async (_body, req) => {
        const sectionId = query(req).get('sectionId')
        if (!sectionId) throw new Error('sectionId is required')
        const list = await runtime.generation.listSectionVersions(sectionId)
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
       handler: envelope('POST', async (body) => {
        const sectionId = asString(body.sectionId)
        const versionId = asString(body.versionId)
        if (!sectionId || !versionId) throw new Error('sectionId and versionId are required')
        const version = await runtime.generation.activateSectionVersion(sectionId, versionId)
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
       handler: envelope('POST', async (body) => {
        const projectId = asString(body.projectId)
        if (!projectId) throw new Error('projectId is required')
        if (asString(body.format) === 'json') {
          const detail = await runtime.host.repository.project.getDetail(projectId)
          return { format: 'json', project: detail }
        }
        const archive = await runtime.exportService.buildImageArchive(projectId)
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
          const bytes = await runtime.assets.readStorageFile(relPath)
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
       handler: envelope('POST', async () => {
        const resolved = await runtime.host.provider.resolve({ operation: 'panel-diagnostics' })
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

    // -- provider utilities ---------------------------------------------------
    {
      // Upstream `POST /api/providers/test`: live connectivity probe of one channel.
      kind: 'exact',
      path: ROUTES.providerTest,
       handler: envelope('POST', async (body) => {
        const channelId = asString(body.channelId)
        const channel = (config.channels ?? []).find((item) => item.id === channelId)
        if (!channel) throw new Error(`channel not found: ${channelId}`)
        const apiKey = readChannelKey(channel)
        if (!apiKey) throw new Error(`渠道 ${channel.id} 未配置密钥。`)
        const adapter = new OpenAICompatibleAdapter(channel.baseUrl, apiKey, runtime.logger)
        const result = await adapter.testConnection()
        return { result }
      }),
    },
    {
      // Upstream `POST /api/providers/discover-models` + `detect-capabilities`:
      // list GET /models, classify by name, recommend per-role defaults.
      kind: 'exact',
      path: ROUTES.providerDiscover,
       handler: envelope('POST', async (body) => {
        const channelId = asString(body.channelId)
        const channel = (config.channels ?? []).find((item) => item.id === channelId)
        if (!channel) throw new Error(`channel not found: ${channelId}`)
        const apiKey = readChannelKey(channel)
        if (!apiKey) throw new Error(`渠道 ${channel.id} 未配置密钥。`)
        const adapter = new OpenAICompatibleAdapter(channel.baseUrl, apiKey, runtime.logger)
        const listed = await adapter.listModels()
        const models = listed.map((item) => ({
          id: item.id,
          label: item.label ?? item.id,
        }))
        const detected = normalizeDetectedModels(models)
        return {
          models: detected.map((model) => ({
            modelId: model.modelId,
            label: model.label,
            capabilities: model.capabilities,
            roles: model.roles,
          })),
          recommendations: recommendDefaultModels(detected),
        }
      }),
    },

    // -- usage monitor --------------------------------------------------------
    {
      // Upstream `/monitor/usage`: summary aggregates + filtered entries.
      kind: 'exact',
      path: ROUTES.usage,
       handler: envelope('GET', async (_body, req) => {
        const params = query(req)
        const entries = (await readUsageEntries(runtime.storeRoot)).map(humanizeEntry)
        const summary = summarizeUsage(entries, {
          hours: Number(params.get('hours') ?? 24) || 24,
          limit: Number(params.get('limit') ?? 50) || 50,
          page: Number(params.get('page') ?? 1) || 1,
          projectId: params.get('projectId') || undefined,
          category: (params.get('category') || 'all') as UsageCategory | 'all',
          quotaState: (params.get('quotaState') || 'all') as QuotaState | 'all',
          success: (params.get('success') || 'all') as 'all' | 'success' | 'failed',
        })
        return { summary }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.usageClear,
       handler: envelope('POST', async () => clearUsageEntries(runtime.storeRoot)),
    },
    {
      kind: 'exact',
      path: ROUTES.usageDelete,
       handler: envelope('POST', async (body) => {
        const id = asString(body.id)
        if (!id) throw new Error('id is required')
        return deleteUsageEntry(runtime.storeRoot, id)
      }),
    },

    // -- batch SKU ------------------------------------------------------------
    {
      // Upstream `POST /api/tasks/batch-create`: one project per SKU image.
      // Project creation is local + fast, so it is synchronous; the optional
      // analyze→plan pass runs as ONE background job with per-item progress.
      kind: 'exact',
      path: ROUTES.batchCreate,
       handler: envelope('POST', async (body) => {
        const items = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : []
        if (items.length < 1 || items.length > 20) throw new Error('supply 1–20 SKU items')
        const created: Array<{ projectId: string; name: string }> = []
        for (const [index, item] of items.entries()) {
          const fileName = asString(item.fileName)
          const base64Data = asString(item.base64Data)
          if (!fileName || !base64Data) throw new Error(`item ${index + 1}: fileName and base64Data are required`)
          const project = await runtime.host.repository.project.create({
            name: asString(item.name) ?? fileName.replace(/\.[^.]+$/, ''),
            platform: asString(body.platform) ?? config.defaultPlatform,
            style: asString(body.style) ?? config.defaultStyle,
          })
          await runtime.assets.saveUploadAsset({
            projectId: project.id,
            type: 'MAIN',
            fileName,
            mimeType: asString(item.mimeType) ?? 'image/png',
            fileBuffer: Buffer.from(base64Data.replace(/^data:[^;]+;base64,/, ''), 'base64'),
            sortOrder: 0,
            isMain: true,
          })
          await runtime.host.repository.project.mergeModelSnapshot(project.id, {
            previewConfig: {
              heroImageCount: config.defaultHeroCount,
              detailSectionCount: config.defaultDetailCount,
              imageAspectRatio: config.defaultDetailAspectRatio,
              contentLanguage: config.defaultLanguage,
            },
          })
          created.push({ projectId: project.id, name: project.name })
        }

        let jobId: string | null = null
        if (body.autoAnalyze === true) {
          const total = created.length
          const handle = runtime.runner.start({
            kind: 'mxpage_batch',
            label: `Batch analyze+plan ${total} project(s)`,
            owner: created[0]!.projectId,
            async run(ctx) {
              let done = 0
              const results: Array<Record<string, unknown>> = []
              for (const item of created) {
                if (ctx.signal.aborted) break
                await ctx.progress.patch({
                  currentProjectId: item.projectId,
                  completedItems: done,
                  totalItems: total,
                  heartbeatAt: new Date().toISOString(),
                })
                try {
                  await runtime.analysis.analyzeProject(item.projectId, null)
                  await runtime.planner.planSections(item.projectId, {
                    modelId: null,
                    previewConfig: {
                      heroImageCount: config.defaultHeroCount,
                      detailSectionCount: config.defaultDetailCount,
                      imageAspectRatio: config.defaultDetailAspectRatio as '3:4' | '9:16',
                      contentLanguage: config.defaultLanguage as never,
                    },
                  })
                  results.push({ projectId: item.projectId, ok: true })
                } catch (error) {
                  // one failing SKU must not take the batch down (验收 §8)
                  results.push({
                    projectId: item.projectId,
                    ok: false,
                    error: redactSecrets(error instanceof Error ? error.message : String(error)),
                  })
                }
                done += 1
              }
              return { completed: done, total, results }
            },
          })
          jobId = handle.id
        }
        return { projects: created, jobId }
      }),
    },

    // -- xiaohongshu --------------------------------------------------------
    {
      kind: 'exact',
      path: ROUTES.xhsPlan,
       handler: envelope('POST', async (body) => {
        const topic = asString(body.topic)
        if (!topic) throw new Error('topic is required')
        const plan = await runtime.xiaohongshu.planXiaohongshuPost({
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
       handler: envelope('POST', async (body) => {
        const plan = body.plan as never
        if (!plan) throw new Error('plan is required')
        const images = await runtime.xiaohongshu.generateXiaohongshuImages(plan, undefined, {
          imageAspectRatio: asString(body.aspectRatio) as '1:1' | '3:4' | '9:16' | undefined,
        })
        return { pages: images }
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.xhsEdit,
       handler: envelope('POST', async (body) => {
        const imageUrlValue = asString(body.imageUrl)
        const prompt = asString(body.prompt)
        if (!imageUrlValue || !prompt) throw new Error('imageUrl and prompt are required')
        const edited = await runtime.xiaohongshu.editXiaohongshuImage({
          imageUrl: imageUrlValue,
          prompt,
          imageAspectRatio: asString(body.aspectRatio) as '1:1' | '3:4' | '9:16' | undefined,
        })
        return { edited }
      }),
    },
  ] as WebRoute[]
}