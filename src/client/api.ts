/**
 * Browser-half data entry point.
 *
 * Thin fetch wrappers over the host routes registered in `src/host/routes.ts`.
 * Every response carries the `{ ok, ... }` envelope; `readEnvelope` unwraps it
 * and turns failures into an `MxpageApiError` carrying the host's stable code.
 */

import { ROUTES } from '../shared/routes.ts'

export class MxpageApiError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'MxpageApiError'
    this.code = code
  }
}

async function readEnvelope<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new MxpageApiError(`HTTP ${response.status}: invalid JSON response`, 'bad-response')
  }
  if (body === null || typeof body !== 'object') {
    throw new MxpageApiError(`HTTP ${response.status}: malformed response`, 'bad-response')
  }
  const record = body as { ok?: unknown; message?: unknown; code?: unknown }
  if (record.ok !== true) {
    throw new MxpageApiError(
      typeof record.message === 'string' ? record.message : `HTTP ${response.status}`,
      typeof record.code === 'string' ? record.code : 'mxpage-error',
    )
  }
  return body as T
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  return readEnvelope<T>(response)
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const search = new URLSearchParams(params).toString()
  const response = await fetch(search ? `${path}?${search}` : path, {
    method: 'GET',
    cache: 'no-store',
  })
  return readEnvelope<T>(response)
}

/** Reads a browser File as bare base64 (no data-URL prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.replace(/^data:[^;]+;base64,/, ''))
    }
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'))
    reader.readAsDataURL(file)
  })
}

// ---------------------------------------------------------------------------
// projections returned by the host
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string
  name: string
  status: string
  platform: string
  style: string
  updatedAt: string
  coverImageUrl: string | null
}

export interface AssetView {
  id: string
  type: string
  fileName: string
  isMain: boolean
  sortOrder: number
  url: string
}

export interface VersionView {
  id: string
  versionNumber: number
  isActive: boolean
  createdAt: string
  imageUrl: string | null
}

export interface SectionView {
  id: string
  sectionKey: string
  type: string
  title: string
  goal: string
  copy: string
  visualPrompt: string
  order: number
  status: string
  editableData: Record<string, unknown> | null
  imageUrl: string | null
  versions: VersionView[]
}

export interface ProjectDetailResponse {
  project: {
    id: string
    name: string
    status: string
    platform: string
    style: string
    modelSnapshot: Record<string, unknown> | null
  }
  analysis: Record<string, unknown> | null
  coverImageUrl: string | null
  assets: AssetView[]
  sections: SectionView[]
}

export interface ChannelDiagnostics {
  channel: { id?: string; label?: string; baseUrl: string }
  modelCount: number
  imageModels: string[]
  textModels: string[]
  visionModels: string[]
  channels: Array<{
    id: string
    label: string
    baseUrl: string
    disabled: boolean
    hasKey: boolean
    models: string[]
  }>
}

export interface JobStatus {
  state: string
  progress: Record<string, unknown> | null
  error?: string | null
}

export interface XiaohongshuPage {
  pageNumber: number
  title: string
  prompt: string
  model: string
  imageUrl: string
  revisedPrompt: string
  updatedAt: string
}

export interface XiaohongshuPlan {
  topic?: string
  pages: Array<{
    pageNumber: number
    title?: string
    body?: string
    imagePrompt?: string
    [key: string]: unknown
  }>
  [key: string]: unknown
}

export interface TaskView {
  id: string
  projectId: string
  sectionId: string | null
  taskType: string
  status: string
  errorMessage: string | null
  outputPayload: Record<string, unknown> | null
  createdAt: string
  completedAt: string | null
}

export interface UsageEntry {
  id: string
  at: string
  endpoint: string
  method: string
  model: string | null
  status: number
  ok: boolean
  durationMs: number
  category: string
  quotaState: string
  errorMessage: string | null
  projectId: string | null
  operation: string | null
  attemptCount: number
}

export interface UsageSummary {
  hours: number
  page: number
  pageSize: number
  totalPages: number
  totalRequests: number
  successRequests: number
  failedRequests: number
  chatRequests: number
  imageRequests: number
  spendingLimitedRequests: number
  rateLimitedRequests: number
  averageDurationMs: number
  topModels: Array<{ model: string; count: number }>
  topProjects: Array<{ projectId: string; count: number }>
  recentEntries: UsageEntry[]
}

export interface DiscoveredModel {
  modelId: string
  label?: string
  capabilities: Record<string, boolean | undefined>
  roles?: Record<string, boolean | undefined>
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export class MxpageApi {
  listProjects(): Promise<{ projects: ProjectSummary[] }> {
    return post(ROUTES.projects)
  }

  /**
   * Create a project and upload its product photos in one call. Reads the files
   * in the browser and posts them as base64, matching the host's JSON-only
   * transport (there is no multipart route).
   */
  async createProjectWithUpload(
    name: string,
    files: File[],
    options: { platform?: string; style?: string } = {},
  ): Promise<{ projectId: string; assetCount: number }> {
    const payload = await Promise.all(
      files.map(async (file) => ({
        fileName: file.name,
        mimeType: file.type || 'image/png',
        base64Data: await fileToBase64(file),
      })),
    )
    return post(ROUTES.projectCreate, { name, files: payload, ...options })
  }

  getProject(id: string): Promise<ProjectDetailResponse> {
    return get(ROUTES.project, { id })
  }

  updateProject(
    id: string,
    patch: { name?: string; platform?: string; style?: string; description?: string },
  ): Promise<{ project: { id: string; name: string; platform: string; style: string; status: string } }> {
    return post(ROUTES.projectUpdate, { id, ...patch })
  }

  deleteProject(id: string): Promise<{ deleted: boolean }> {
    return post(ROUTES.projectDelete, { id })
  }

  reorderAssets(projectId: string, orderedAssetIds: string[]): Promise<{ reordered: number }> {
    return post(ROUTES.assetsReorder, { projectId, orderedAssetIds })
  }

  setMainAsset(projectId: string, assetId: string): Promise<unknown> {
    return post(ROUTES.assetSetMain, { projectId, assetId })
  }

  deleteAsset(assetId: string): Promise<{ deleted: boolean }> {
    return post(ROUTES.assetDelete, { assetId })
  }

  saveAnalysis(projectId: string, analysis: Record<string, unknown>): Promise<{ saved: boolean }> {
    return post(ROUTES.analysisSave, { projectId, analysis })
  }

  translatePage(projectId: string, targetLanguage: string): Promise<{ jobId: string; total: number }> {
    return post(ROUTES.translatePage, { projectId, targetLanguage })
  }

  listTasks(projectId?: string, limit = 50): Promise<{ tasks: TaskView[] }> {
    return get(ROUTES.tasks, projectId ? { projectId, limit: String(limit) } : { limit: String(limit) })
  }

  retryTask(taskId: string): Promise<{ retried: boolean; taskType: string; jobId?: string; imageUrl?: string }> {
    return post(ROUTES.taskRetry, { taskId })
  }

  providerTest(channelId: string): Promise<{ result: unknown }> {
    return post(ROUTES.providerTest, { channelId })
  }

  providerDiscover(channelId: string): Promise<{
    models: DiscoveredModel[]
    recommendations: Record<string, string | null>
  }> {
    return post(ROUTES.providerDiscover, { channelId })
  }

  usage(params: {
    hours?: number
    page?: number
    limit?: number
    projectId?: string
    category?: string
    quotaState?: string
    success?: string
  }): Promise<{ summary: UsageSummary }> {
    const search: Record<string, string> = {}
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search[key] = String(value)
    }
    return get(ROUTES.usage, search)
  }

  usageClear(): Promise<{ cleared: boolean }> {
    return post(ROUTES.usageClear)
  }

  usageDelete(id: string): Promise<{ deleted: boolean }> {
    return post(ROUTES.usageDelete, { id })
  }

  async batchCreate(
    items: Array<{ name: string; file: File }>,
    options: { autoAnalyze?: boolean; platform?: string; style?: string } = {},
  ): Promise<{ projects: Array<{ projectId: string; name: string }>; jobId: string | null }> {
    const payload = await Promise.all(
      items.map(async (item) => ({
        name: item.name,
        fileName: item.file.name,
        mimeType: item.file.type || 'image/png',
        base64Data: await fileToBase64(item.file),
      })),
    )
    return post(ROUTES.batchCreate, { items: payload, ...options })
  }

  upload(input: {
    projectId: string
    fileName: string
    mimeType: string
    base64Data: string
    role?: string
  }): Promise<{ assetId: string; url: string }> {
    return post(ROUTES.upload, input)
  }

  analyze(projectId: string, model?: string): Promise<{ analysis: unknown }> {
    return post(ROUTES.analyze, { projectId, model })
  }

  plan(
    projectId: string,
    previewConfig: Record<string, unknown>,
    options: { model?: string; autoDecideCounts?: boolean } = {},
  ): Promise<{ visualStyleGuide: unknown; previewConfig: unknown; fallbackMode: string | null }> {
    return post(ROUTES.plan, { projectId, previewConfig, ...options })
  }

  regenerateStyleGuide(projectId: string, model?: string): Promise<{ visualStyleGuide: unknown }> {
    return post(ROUTES.styleGuide, { projectId, model })
  }

  updateSection(sectionId: string, patch: Record<string, unknown>): Promise<{ section: SectionView }> {
    return post(ROUTES.section, { sectionId, patch })
  }

  createSection(
    projectId: string,
    input: { type?: string; title?: string; goal?: string; copy?: string; visualPrompt?: string },
  ): Promise<{ section: SectionView }> {
    return post(ROUTES.sectionCreate, { projectId, ...input })
  }

  deleteSection(sectionId: string): Promise<unknown> {
    return post(ROUTES.sectionDelete, { sectionId })
  }

  reorder(projectId: string, orderedSectionIds: string[]): Promise<unknown> {
    return post(ROUTES.reorder, { projectId, orderedSectionIds })
  }

  generateSection(
    projectId: string,
    sectionId: string,
    options: { regenerate?: boolean; model?: string } = {},
  ): Promise<{ versionId: string; imageUrl: string; modelUsed: string }> {
    return post(ROUTES.generate, { projectId, sectionId, ...options })
  }

  editSection(
    projectId: string,
    sectionId: string,
    editMode: 'repaint' | 'enhance' | 'translate',
    extra: { targetLanguage?: string; model?: string } = {},
  ): Promise<{ versionId: string; imageUrl: string; editMode: string }> {
    return post(ROUTES.edit, { projectId, sectionId, editMode, ...extra })
  }

  generatePage(projectId: string, mode: 'missing' | 'all'): Promise<{ jobId: string; total: number }> {
    return post(ROUTES.generatePage, { projectId, mode })
  }

  jobStatus(jobId: string): Promise<JobStatus> {
    return get(ROUTES.job, { id: jobId })
  }

  cancelJob(jobId: string): Promise<unknown> {
    return post(ROUTES.jobCancel, { jobId })
  }

  listVersions(sectionId: string): Promise<{ versions: VersionView[] }> {
    return get(ROUTES.versions, { sectionId })
  }

  activateVersion(sectionId: string, versionId: string): Promise<{ imageUrl: string | null }> {
    return post(ROUTES.versionActivate, { sectionId, versionId })
  }

  exportProject(
    projectId: string,
    format: 'zip' | 'json',
  ): Promise<{ format: string; zipPath?: string; fileName?: string; byteLength?: number }> {
    return post(ROUTES.export, { projectId, format })
  }

  channels(): Promise<ChannelDiagnostics> {
    return post(ROUTES.channels)
  }

  xhsPlan(topic: string, imageCount: number, aspectRatio: string): Promise<{ plan: XiaohongshuPlan }> {
    return post(ROUTES.xhsPlan, { topic, imageCount, aspectRatio })
  }

  xhsGenerate(
    plan: XiaohongshuPlan,
    aspectRatio: string,
  ): Promise<{ pages: XiaohongshuPage[] }> {
    return post(ROUTES.xhsGenerate, { plan, aspectRatio })
  }

  xhsEdit(imageUrl: string, prompt: string, aspectRatio: string): Promise<{ edited: { imageUrl: string } }> {
    return post(ROUTES.xhsEdit, { imageUrl, prompt, aspectRatio })
  }
}
