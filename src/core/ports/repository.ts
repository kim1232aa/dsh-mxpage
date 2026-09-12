/**
 * Port: Repository.
 *
 * Replaces upstream's `import { prisma } from "@/lib/db/prisma"` — roughly 40
 * call sites across `analysis-service`, `planner-service`, `generation-service`,
 * `export-service`, `workflow-task-service`, `task-service` and `asset-manager`.
 *
 * Design notes:
 *  - This is NOT a Prisma clone. Methods are named after intents observed in
 *    the services, so porting a service is a local edit rather than a rewrite
 *    of its query shape.
 *  - Relations the services relied on via `include` are exposed as explicit
 *    aggregate reads (`getDetail`, `listVersions`) rather than lazy traversal.
 *  - `patchProjectModelSnapshot`'s compare-and-swap loop over
 *    `Project.updatedAt` is unnecessary in a single-writer host, so it collapses
 *    into `mergeModelSnapshot`.
 *
 * Every implementation must be safe for concurrent calls from one process.
 */

import type {
  AssetType,
  GenerationStatus,
  GenerationTask,
  PageSection,
  PageSectionWithVersions,
  ProductAnalysis,
  ProductAsset,
  Project,
  ProjectDetail,
  ProjectStatus,
  SectionType,
  SectionVersion,
  TaskStatus,
  TaskType,
  ModelSnapshot,
} from '../types/domain.ts'

// ---------------------------------------------------------------------------
// Filters / inputs
// ---------------------------------------------------------------------------

export interface ProjectListFilter {
  /** When false (default), the hidden system-task project is excluded. */
  includeSystem?: boolean
  status?: ProjectStatus
  limit?: number
}

export interface CreateProjectInput {
  name: string
  platform: string
  style: string
  description?: string | null
}

export interface UpdateProjectInput {
  name?: string
  status?: ProjectStatus
  platform?: string
  style?: string
  description?: string | null
  modelSnapshot?: ModelSnapshot | null
}

export interface CreateAssetInput {
  projectId: string
  sectionId?: string | null
  type: AssetType
  filePath: string
  fileName: string
  mimeType?: string | null
  sortOrder: number
  metadata?: Record<string, unknown> | null
  isMain: boolean
}

export interface AssetFilter {
  projectId?: string
  sectionId?: string | null
  type?: AssetType
}

export interface CreateSectionInput {
  projectId: string
  sectionKey: string
  type: SectionType
  title: string
  goal: string
  copy: string
  visualPrompt: string
  order: number
  editableData?: Record<string, unknown> | null
}

export interface UpdateSectionInput {
  /**
   * Upstream `normalizeProjectSections` rewrites this in place to keep section
   * keys stable and unique per project.
   */
  sectionKey?: string
  type?: SectionType
  title?: string
  goal?: string
  copy?: string
  visualPrompt?: string
  order?: number
  status?: GenerationStatus
  currentImageAssetId?: string | null
  editableData?: Record<string, unknown> | null
}

export interface CreateVersionInput {
  sectionId: string
  promptSnapshot?: unknown
  copySnapshot?: unknown
  imageAssetId?: string | null
  /** Defaults to the next monotonic number for the section. */
  versionNumber?: number
}

export interface CreateTaskInput {
  projectId: string
  sectionId?: string | null
  taskType: TaskType
  /** Upstream defaults `createTask` to RUNNING. */
  status?: TaskStatus
  inputPayload?: unknown
  outputPayload?: Record<string, unknown> | null
}

export interface RunningTaskFilter {
  projectId: string
  sectionId?: string | null
  taskType: TaskType | TaskType[]
  maxAgeMinutes?: number
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface ProjectRepository {
  get(id: string): Promise<Project | null>
  /** Project + assets + analysis + sections(+versions) in one read. */
  getDetail(id: string): Promise<ProjectDetail | null>
  list(filter?: ProjectListFilter): Promise<Project[]>
  create(input: CreateProjectInput): Promise<Project>
  update(id: string, patch: UpdateProjectInput): Promise<Project>
  delete(id: string): Promise<void>
  /** Shallow-merges into `modelSnapshot` (replaces the upstream CAS loop). */
  mergeModelSnapshot(id: string, patch: Partial<ModelSnapshot>): Promise<Project>
  /** Finds the lazily-created placeholder project used by batch / XHS tasks. */
  findOrCreateSystemProject(): Promise<Project>
}

export interface AssetRepository {
  create(input: CreateAssetInput): Promise<ProductAsset>
  get(id: string): Promise<ProductAsset | null>
  list(filter: AssetFilter): Promise<ProductAsset[]>
  count(projectId: string): Promise<number>
  setMain(projectId: string, assetId: string): Promise<void>
  updateSortOrder(assetId: string, sortOrder: number): Promise<void>
  updateSectionId(assetId: string, sectionId: string | null): Promise<void>
  updateMetadata(assetId: string, metadata: Record<string, unknown>): Promise<void>
  delete(id: string): Promise<void>
  /** True when no `PageSection.currentImageAssetId` / `SectionVersion.imageAssetId` points at it. */
  isReferenced(assetId: string): Promise<boolean>
}

export interface AnalysisRepository {
  get(projectId: string): Promise<ProductAnalysis | null>
  upsert(
    projectId: string,
    data: { rawResult: unknown; normalizedResult: unknown },
  ): Promise<ProductAnalysis>
}

export interface SectionRepository {
  get(id: string): Promise<PageSection | null>
  getByKey(projectId: string, sectionKey: string): Promise<PageSection | null>
  list(projectId: string): Promise<PageSection[]>
  listWithVersions(projectId: string): Promise<PageSectionWithVersions[]>
  create(input: CreateSectionInput): Promise<PageSection>
  createMany(inputs: CreateSectionInput[]): Promise<PageSection[]>
  update(id: string, patch: UpdateSectionInput): Promise<PageSection>
  updateMany(ids: string[], patch: UpdateSectionInput): Promise<void>
  delete(id: string): Promise<void>
  /** Upstream `planSections` wipes all sections before re-planning. */
  deleteAll(projectId: string): Promise<void>
  reorder(projectId: string, orderedSectionIds: string[]): Promise<void>
}

export interface VersionRepository {
  list(sectionId: string): Promise<SectionVersion[]>
  get(id: string): Promise<SectionVersion | null>
  /** Next monotonic version number for a section (1-based). */
  nextVersionNumber(sectionId: string): Promise<number>
  create(input: CreateVersionInput): Promise<SectionVersion>
  /** Marks every other version of the section inactive. */
  setActive(sectionId: string, versionId: string): Promise<SectionVersion>
}

export interface TaskRepository {
  create(input: CreateTaskInput): Promise<GenerationTask>
  get(id: string): Promise<GenerationTask | null>
  update(id: string, patch: Partial<CreateTaskInput> & { errorMessage?: string | null; startedAt?: Date | null; completedAt?: Date | null }): Promise<GenerationTask>
  /**
   * Merges `patch` into `outputPayload`. MUST be a no-op when the task is in a
   * terminal state (SUCCESS / FAILED / CANCELED) — upstream relies on this
   * "terminal-state stickiness" for correctness.
   */
  mergeProgress(id: string, patch: Record<string, unknown>): Promise<GenerationTask | null>
  list(projectId: string, limit?: number): Promise<GenerationTask[]>
  /** Dedupe / mutual-exclusion guard. */
  findRecentRunning(filter: RunningTaskFilter): Promise<GenerationTask | null>
  /**
   * Marks stale bulk tasks FAILED. Never re-dispatches — upstream only ever
   * failed orphans after a restart.
   */
  recoverStale(projectId: string, staleMs: number): Promise<GenerationTask[]>
}

export interface Repository {
  project: ProjectRepository
  asset: AssetRepository
  analysis: AnalysisRepository
  section: SectionRepository
  version: VersionRepository
  task: TaskRepository
  /** Releases resources (e.g. a SQLite handle). Optional. */
  close?(): Promise<void>
}
