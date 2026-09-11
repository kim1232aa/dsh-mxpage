import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.ts'
import { analyzeProduct, readAnalysisFile } from '../pipeline/analyze.ts'
import { generateSection } from '../pipeline/generate.ts'
import { planPage, readPlanFile, type NormalizedSection } from '../pipeline/plan.ts'
import { createImagesClient, type ImagesClient } from '../provider/openai-images.ts'
import type { CompleteJson } from '../provider/vision-text.ts'
import type { ProjectStore } from '../service/project-store.ts'
import { redactSecrets } from '../util/redact.ts'
import {
  registerLiveJob,
  writeJobProgress,
  type JobProgressState,
  type MxpageJobsApi,
} from './job.ts'
import type { JobKind } from '@deepseek-ai/dsh-jobs'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    mxpage_page: 'mxpage_page'
  }
}

const PAGE_KIND: JobKind = 'mxpage_page'

const MISSING_KEY = '未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）'
const textRender = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]

function abortError(message = '已取消'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

function isAbortErr(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (!err || typeof err !== 'object') return false
  const rec = err as { name?: string; message?: string }
  return rec.name === 'AbortError' || rec.message === '已取消'
}

function tryStatus(store: ProjectStore, projectId: string, status: string): void {
  try {
    store.write(projectId, { status })
  } catch {
    // ignore illegal transitions
  }
}

function resolveImages(config: Config, injected?: ImagesClient): ImagesClient | undefined {
  if (injected) return injected
  const apiKey = process.env[config.imageApiKeyEnv]
  if (!apiKey) return undefined
  return createImagesClient({ baseUrl: config.imageBaseUrl, apiKey })
}

async function withSectionLock(
  locks: Map<string, Promise<void>>,
  key: string,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const curr = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(key, prev.then(() => curr, () => curr))
  try {
    await prev.catch(() => undefined)
    await fn()
  } finally {
    release()
  }
}

async function runPool(
  keys: string[],
  limit: number,
  signal: AbortSignal,
  worker: (key: string) => Promise<void>,
): Promise<void> {
  if (keys.length === 0) return
  const conc = Math.max(1, limit)
  let index = 0
  let failed: unknown
  const runWorker = async () => {
    while (true) {
      if (signal.aborted) throw abortError()
      if (failed) return
      const i = index++
      if (i >= keys.length) return
      try {
        await worker(keys[i]!)
      } catch (err) {
        failed = err
        throw err
      }
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(conc, keys.length) }, () => runWorker()),
  )
  if (signal.aborted) throw abortError()
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (rejected) throw rejected.reason
}

export interface PageJobDeps {
  store: ProjectStore
  storeRoot: string
  config: Config
  images: ImagesClient
  saveImage: (input: {
    data: Uint8Array
    mediaType: string
    name?: string
  }) => Promise<{ attachmentId: string }>
  completeJson?: CompleteJson
}

export async function runPageJob(
  deps: PageJobDeps,
  args: { projectId: string; sectionKeys?: string[] },
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  const record0 = deps.store.read(args.projectId)
  const projectDir = record0.workspaceDir
  let lastProgress = 0
  const persist = (state: JobProgressState, progress: number, currentSection: string, error?: string) => {
    lastProgress = progress
    writeJobProgress(projectDir, jobId, {
      state,
      progress,
      currentSection,
      ...(error ? { error } : {}),
    })
  }

  persist('running', 0, '')
  const locks = new Map<string, Promise<void>>()

  try {
    if (signal.aborted) throw abortError()
    const rec = deps.store.read(args.projectId)
    const hasAnalysis = Boolean(readAnalysisFile(rec.workspaceDir))
    const skipAnalyze = hasAnalysis
      || rec.status === 'analyzed'
      || rec.status === 'planned'
      || rec.status === 'generating'
      || rec.status === 'generated'
    if (!skipAnalyze) {
      persist('running', 0.05, 'analyze')
      const analyzed = await analyzeProduct(
        { store: deps.store, completeJson: deps.completeJson },
        { projectId: args.projectId },
        signal,
      )
      if (!analyzed.ok) throw new Error(analyzed.error)
    }
    persist('running', 0.1, 'analyze')

    if (signal.aborted) throw abortError()
    const planExisting = readPlanFile(deps.store.read(args.projectId).workspaceDir)
    const skipPlan = Boolean(planExisting && planExisting.sections.length > 0)
    if (!skipPlan) {
      persist('running', 0.12, 'plan')
      const planned = await planPage(
        { store: deps.store, config: deps.config, completeJson: deps.completeJson },
        { projectId: args.projectId },
        signal,
      )
      if (!planned.ok) throw new Error(planned.error)
    }
    persist('running', 0.2, 'plan')

    const latest = deps.store.read(args.projectId)
    const plan = readPlanFile(latest.workspaceDir)
    if (!plan || plan.sections.length === 0) throw new Error('MXPAGE_STATE')

    const outputDir = join(latest.workspaceDir, 'output')
    const requested = args.sectionKeys
    const selected: NormalizedSection[] = requested?.length
      ? plan.sections.filter((section) => requested.includes(section.sectionKey))
      : plan.sections.filter((section) => !existsSync(join(outputDir, `${section.sectionKey}.png`)))

    const heroes = selected.filter((section) => section.type === 'hero' || section.sectionKey.startsWith('hero_'))
    const details = selected.filter((section) => !heroes.includes(section))
    const total = heroes.length + details.length
    let completed = 0

    if (latest.status !== 'generating') tryStatus(deps.store, latest.id, 'generating')

    const generateOne = async (sectionKey: string) => {
      await withSectionLock(locks, sectionKey, async () => {
        if (signal.aborted) throw abortError()
        persist('running', total === 0 ? 0.2 : 0.2 + 0.8 * (completed / total), sectionKey)
        const result = await generateSection(
          {
            store: deps.store,
            storeRoot: deps.storeRoot,
            config: deps.config,
            images: deps.images,
            saveImage: deps.saveImage,
            completeJson: deps.completeJson,
          },
          { projectId: args.projectId, sectionKey },
          signal,
        )
        if (!result.ok) throw new Error(result.error)
        completed += 1
        persist('running', total === 0 ? 1 : 0.2 + 0.8 * (completed / total), sectionKey)
      })
    }

    const parallel = deps.config.maxParallelSections || 2
    await runPool(heroes.map((section) => section.sectionKey), parallel, signal, generateOne)
    if (signal.aborted) throw abortError()
    await runPool(details.map((section) => section.sectionKey), parallel, signal, generateOne)

    tryStatus(deps.store, args.projectId, 'generated')
    persist('completed', 1, '')
  } catch (err) {
    const aborted = isAbortErr(err, signal)
    persist(
      aborted ? 'killed' : 'failed',
      lastProgress,
      '',
      redactSecrets(err instanceof Error ? err.message : String(err)),
    )
    if (!aborted) tryStatus(deps.store, args.projectId, 'failed')
    if (aborted) throw abortError(err instanceof Error ? err.message : '已取消')
    throw err instanceof Error ? err : new Error(String(err))
  }
}

export function generatePageTool(opts: {
  store: ProjectStore
  storeRoot: string
  config: Config
  saveImage: (input: {
    data: Uint8Array
    mediaType: string
    name?: string
  }) => Promise<{ attachmentId: string }>
  images?: ImagesClient
  completeJson?: CompleteJson
  jobs?: MxpageJobsApi
}) {
  return defineTool({
    name: 'mxpage_generate_page',
    description:
      'Generate a full ecommerce detail page (analyze → plan → all heroes → details). Uses a background job and consumes image API quota. Default section_keys are planned modules without output/<key>.png. Returns { kind: "background", jobId }.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Existing mxpage project id' },
      section_keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subset of section keys; default is planned sections missing output/<key>.png',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: textRender,
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    execute: async (args, exec): Promise<Record<string, string | number | boolean>> => {
      const images = resolveImages(opts.config, opts.images)
      if (images === undefined) return { ok: false, error: MISSING_KEY }
      if (!opts.jobs?.start) throw new Error('请加载 @deepseek-ai/dsh-jobs')
      if (exec.signal.aborted) throw abortError()

      let record
      try {
        record = opts.store.read(args.project_id)
      } catch {
        return { ok: false, error: 'MXPAGE_NOT_FOUND' }
      }

      const ac = new AbortController()
      const projectId = args.project_id
      const sectionKeys = args.section_keys
      const pageDeps: PageJobDeps = {
        store: opts.store,
        storeRoot: opts.storeRoot,
        config: opts.config,
        images,
        saveImage: opts.saveImage,
        completeJson: opts.completeJson,
      }
      let resolveStart!: (id: string) => void
      let rejectStart!: (err: unknown) => void
      const started = new Promise<string>((res, rej) => {
        resolveStart = res
        rejectStart = rej
      })
      const work = started.then((id) => runPageJob(
        pageDeps,
        { projectId, sectionKeys },
        id,
        ac.signal,
      ))
      work.catch(() => {})
      try {
        const jobId = opts.jobs.start({
          kind: PAGE_KIND,
          label: `mxpage page ${projectId}`,
          ...(exec.agent ? { owner: exec.agent } : {}),
          run: () => ({
            cancel: (reason?: string) => ac.abort(reason),
            done: work.then(
              () => ({ status: 'completed' as const }),
              (err) => {
                const aborted = isAbortErr(err, ac.signal)
                return {
                  status: (aborted ? 'killed' : 'failed') as 'killed' | 'failed',
                  detail: redactSecrets(String(err instanceof Error ? err.message : err)),
                }
              },
            ),
          }),
        })
        registerLiveJob(jobId, { projectDir: record.workspaceDir, abort: ac })
        resolveStart(jobId)
        return { kind: 'background', jobId }
      } catch (err) {
        ac.abort()
        rejectStart(err)
        throw err
      }
    },
  })
}
