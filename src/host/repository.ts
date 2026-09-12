/**
 * Host implementation of the Repository port.
 *
 * Deliberately NOT Prisma. Upstream's schema is 7 models / 6 enums, and Prisma
 * ships a query-engine binary that cannot be bundled into a DSH plugin (the
 * upstream project itself had to `asarUnpack` it for Electron). A single
 * atomically-written JSON document is equivalent at this scale and has zero
 * native dependencies.
 *
 * The on-disk schema mirrors upstream's Prisma models 1:1 so a later migration
 * to SQLite is mechanical.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type {
  AssetRepository,
  AnalysisRepository,
  CreateAssetInput,
  CreateProjectInput,
  CreateSectionInput,
  CreateTaskInput,
  CreateVersionInput,
  ProjectListFilter,
  ProjectRepository,
  Repository,
  RunningTaskFilter,
  SectionRepository,
  TaskRepository,
  UpdateProjectInput,
  UpdateSectionInput,
  VersionRepository,
} from '../core/ports/repository.ts'
import { SYSTEM_TASK_PLATFORM } from '../core/types/domain.ts'
import type {
  GenerationTask,
  PageSection,
  PageSectionWithVersions,
  ProductAnalysis,
  ProductAsset,
  Project,
  ProjectDetail,
  SectionVersion,
  TaskStatus,
} from '../core/types/domain.ts'

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface DbShape {
  version: 1
  projects: Project[]
  assets: ProductAsset[]
  analyses: ProductAnalysis[]
  sections: PageSection[]
  versions: SectionVersion[]
  tasks: GenerationTask[]
}

const DATE_FIELDS = [
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
] as const

function revive<T>(value: T): T {
  if (Array.isArray(value)) return value.map(revive) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        (DATE_FIELDS as readonly string[]).includes(key) && typeof raw === 'string'
          ? new Date(raw)
          : revive(raw)
    }
    return out as T
  }
  return value
}

function serialize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(serialize)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serialize(raw)
    }
    return out
  }
  return value
}

function emptyDb(): DbShape {
  return { version: 1, projects: [], assets: [], analyses: [], sections: [], versions: [], tasks: [] }
}

const TERMINAL: readonly TaskStatus[] = ['SUCCESS', 'FAILED', 'CANCELED']
const isTerminal = (status: TaskStatus): boolean => TERMINAL.includes(status)

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface JsonRepositoryOptions {
  /** Path of the JSON document. Parent directories are created on demand. */
  file: string
}

export function createJsonRepository(options: JsonRepositoryOptions): Repository {
  const file = path.resolve(options.file)
  let db: DbShape | null = null
  let writeChain: Promise<void> = Promise.resolve()

  async function load(): Promise<DbShape> {
    if (db) return db
    try {
      const raw = await fs.readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as DbShape
      db = { ...emptyDb(), ...(revive(parsed) as DbShape) }
    } catch {
      db = emptyDb()
    }
    return db
  }

  /** Serialized, atomic: write a sibling temp file then rename over the target. */
  function persist(): Promise<void> {
    writeChain = writeChain.then(async () => {
      if (!db) return
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(serialize(db), null, 2), 'utf8')
      await fs.rename(tmp, file)
    })
    return writeChain
  }

  const now = () => new Date()

  function findProject(id: string): Project | undefined {
    return db!.projects.find((item) => item.id === id)
  }

  // -- project ---------------------------------------------------------------

  const project: ProjectRepository = {
    async get(id) {
      await load()
      return findProject(id) ?? null
    },

    async getDetail(id) {
      await load()
      const found = findProject(id)
      if (!found) return null
      const sections: PageSectionWithVersions[] = db!.sections
        .filter((section) => section.projectId === id)
        .sort((a, b) => a.order - b.order)
        .map((section) => ({
          ...section,
          versions: db!.versions
            .filter((version) => version.sectionId === section.id)
            .sort((a, b) => a.versionNumber - b.versionNumber),
        }))
      const detail: ProjectDetail = {
        ...found,
        assets: db!.assets
          .filter((asset) => asset.projectId === id)
          .sort((a, b) => a.sortOrder - b.sortOrder),
        analysis: db!.analyses.find((item) => item.projectId === id) ?? null,
        sections,
      }
      return detail
    },

    async list(filter: ProjectListFilter = {}) {
      await load()
      let items = db!.projects.slice()
      if (!filter.includeSystem) {
        items = items.filter((item) => item.platform !== SYSTEM_TASK_PLATFORM)
      }
      if (filter.status) items = items.filter((item) => item.status === filter.status)
      items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      return filter.limit ? items.slice(0, filter.limit) : items
    },

    async create(input: CreateProjectInput) {
      await load()
      const timestamp = now()
      const record: Project = {
        id: `prj_${randomUUID()}`,
        name: input.name,
        status: 'DRAFT',
        platform: input.platform,
        style: input.style,
        description: input.description ?? null,
        modelSnapshot: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      db!.projects.push(record)
      await persist()
      return record
    },

    async update(id, patch: UpdateProjectInput) {
      await load()
      const record = findProject(id)
      if (!record) throw new Error(`project not found: ${id}`)
      if (patch.name !== undefined) record.name = patch.name
      if (patch.status !== undefined) record.status = patch.status
      if (patch.platform !== undefined) record.platform = patch.platform
      if (patch.style !== undefined) record.style = patch.style
      if (patch.description !== undefined) record.description = patch.description
      if (patch.modelSnapshot !== undefined) record.modelSnapshot = patch.modelSnapshot
      record.updatedAt = now()
      await persist()
      return record
    },

    async delete(id) {
      await load()
      const sectionIds = db!.sections
        .filter((section) => section.projectId === id)
        .map((section) => section.id)
      db!.projects = db!.projects.filter((item) => item.id !== id)
      db!.assets = db!.assets.filter((item) => item.projectId !== id)
      db!.analyses = db!.analyses.filter((item) => item.projectId !== id)
      db!.sections = db!.sections.filter((item) => item.projectId !== id)
      db!.versions = db!.versions.filter((item) => !sectionIds.includes(item.sectionId))
      db!.tasks = db!.tasks.filter((item) => item.projectId !== id)
      await persist()
    },

    /**
     * Upstream's `patchProjectModelSnapshot` did a compare-and-swap loop over
     * `Project.updatedAt` to survive concurrent writers. Single-writer host, so
     * a plain shallow merge is sufficient.
     */
    async mergeModelSnapshot(id, patch) {
      await load()
      const record = findProject(id)
      if (!record) throw new Error(`project not found: ${id}`)
      record.modelSnapshot = { ...(record.modelSnapshot ?? {}), ...patch }
      record.updatedAt = now()
      await persist()
      return record
    },

    async findOrCreateSystemProject() {
      await load()
      const existing = db!.projects.find((item) => item.platform === SYSTEM_TASK_PLATFORM)
      if (existing) return existing
      const timestamp = now()
      const record: Project = {
        id: `prj_${randomUUID()}`,
        name: '__mxpage_system_task__',
        status: 'DRAFT',
        platform: SYSTEM_TASK_PLATFORM,
        style: 'generic_clean',
        description: null,
        modelSnapshot: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      db!.projects.push(record)
      await persist()
      return record
    },
  }

  // -- asset -----------------------------------------------------------------

  const asset: AssetRepository = {
    async create(input: CreateAssetInput) {
      await load()
      const record: ProductAsset = {
        id: `ast_${randomUUID()}`,
        projectId: input.projectId,
        sectionId: input.sectionId ?? null,
        type: input.type,
        filePath: input.filePath,
        fileName: input.fileName,
        mimeType: input.mimeType ?? null,
        sortOrder: input.sortOrder,
        metadata: input.metadata ?? null,
        isMain: input.isMain,
        createdAt: now(),
      }
      db!.assets.push(record)
      await persist()
      return record
    },

    async get(id) {
      await load()
      return db!.assets.find((item) => item.id === id) ?? null
    },

    async list(filter) {
      await load()
      let items = db!.assets.slice()
      if (filter.projectId) items = items.filter((item) => item.projectId === filter.projectId)
      if (filter.type) items = items.filter((item) => item.type === filter.type)
      if (filter.sectionId !== undefined) {
        items = items.filter((item) => (item.sectionId ?? null) === filter.sectionId)
      }
      items.sort((a, b) => a.sortOrder - b.sortOrder)
      return items
    },

    async count(projectId) {
      await load()
      return db!.assets.filter((item) => item.projectId === projectId).length
    },

    async setMain(projectId, assetId) {
      await load()
      for (const item of db!.assets) {
        if (item.projectId === projectId) item.isMain = item.id === assetId
      }
      await persist()
    },

    async updateSortOrder(assetId, sortOrder) {
      await load()
      const record = db!.assets.find((item) => item.id === assetId)
      if (!record) return
      record.sortOrder = sortOrder
      await persist()
    },

    async updateSectionId(assetId, sectionId) {
      await load()
      const record = db!.assets.find((item) => item.id === assetId)
      if (!record) return
      record.sectionId = sectionId
      await persist()
    },

    async updateMetadata(assetId, metadata) {
      await load()
      const record = db!.assets.find((item) => item.id === assetId)
      if (!record) return
      record.metadata = { ...(record.metadata ?? {}), ...metadata }
      await persist()
    },

    async delete(id) {
      await load()
      db!.assets = db!.assets.filter((item) => item.id !== id)
      await persist()
    },

    async isReferenced(assetId) {
      await load()
      if (db!.sections.some((section) => section.currentImageAssetId === assetId)) return true
      return db!.versions.some((version) => version.imageAssetId === assetId)
    },
  }

  // -- analysis --------------------------------------------------------------

  const analysis: AnalysisRepository = {
    async get(projectId) {
      await load()
      return db!.analyses.find((item) => item.projectId === projectId) ?? null
    },

    async upsert(projectId, data) {
      await load()
      const existing = db!.analyses.find((item) => item.projectId === projectId)
      if (existing) {
        existing.rawResult = data.rawResult
        existing.normalizedResult = data.normalizedResult
        existing.updatedAt = now()
        await persist()
        return existing
      }
      const timestamp = now()
      const record: ProductAnalysis = {
        id: `ana_${randomUUID()}`,
        projectId,
        rawResult: data.rawResult,
        normalizedResult: data.normalizedResult,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      db!.analyses.push(record)
      await persist()
      return record
    },
  }

  // -- section ---------------------------------------------------------------

  const section: SectionRepository = {
    async get(id) {
      await load()
      return db!.sections.find((item) => item.id === id) ?? null
    },

    async getByKey(projectId, sectionKey) {
      await load()
      return (
        db!.sections.find(
          (item) => item.projectId === projectId && item.sectionKey === sectionKey,
        ) ?? null
      )
    },

    async list(projectId) {
      await load()
      return db!.sections
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => a.order - b.order)
    },

    async listWithVersions(projectId) {
      await load()
      return db!.sections
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => a.order - b.order)
        .map((item) => ({
          ...item,
          versions: db!.versions
            .filter((version) => version.sectionId === item.id)
            .sort((a, b) => a.versionNumber - b.versionNumber),
        }))
    },

    async create(input: CreateSectionInput) {
      await load()
      const timestamp = now()
      const record: PageSection = {
        id: `sec_${randomUUID()}`,
        projectId: input.projectId,
        sectionKey: input.sectionKey,
        type: input.type,
        title: input.title,
        goal: input.goal,
        copy: input.copy,
        visualPrompt: input.visualPrompt,
        order: input.order,
        status: 'IDLE',
        currentImageAssetId: null,
        editableData: input.editableData ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      db!.sections.push(record)
      await persist()
      return record
    },

    async createMany(inputs: CreateSectionInput[]) {
      await load()
      const created: PageSection[] = []
      for (const input of inputs) {
        const timestamp = now()
        const record: PageSection = {
          id: `sec_${randomUUID()}`,
          projectId: input.projectId,
          sectionKey: input.sectionKey,
          type: input.type,
          title: input.title,
          goal: input.goal,
          copy: input.copy,
          visualPrompt: input.visualPrompt,
          order: input.order,
          status: 'IDLE',
          currentImageAssetId: null,
          editableData: input.editableData ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        db!.sections.push(record)
        created.push(record)
      }
      await persist()
      return created
    },

    async update(id, patch: UpdateSectionInput) {
      await load()
      const record = db!.sections.find((item) => item.id === id)
      if (!record) throw new Error(`section not found: ${id}`)
      Object.assign(record, patch)
      record.updatedAt = now()
      await persist()
      return record
    },

    async updateMany(ids, patch) {
      await load()
      for (const record of db!.sections) {
        if (!ids.includes(record.id)) continue
        Object.assign(record, patch)
        record.updatedAt = now()
      }
      await persist()
    },

    async delete(id) {
      await load()
      db!.sections = db!.sections.filter((item) => item.id !== id)
      db!.versions = db!.versions.filter((item) => item.sectionId !== id)
      await persist()
    },

    /** Upstream `planSections` wipes everything before re-planning. */
    async deleteAll(projectId) {
      await load()
      const doomed = db!.sections
        .filter((item) => item.projectId === projectId)
        .map((item) => item.id)
      db!.sections = db!.sections.filter((item) => item.projectId !== projectId)
      db!.versions = db!.versions.filter((item) => !doomed.includes(item.sectionId))
      await persist()
    },

    async reorder(projectId, orderedSectionIds) {
      await load()
      orderedSectionIds.forEach((id, index) => {
        const record = db!.sections.find((item) => item.id === id && item.projectId === projectId)
        if (record) record.order = index
      })
      await persist()
    },
  }

  // -- version ---------------------------------------------------------------

  const version: VersionRepository = {
    async list(sectionId) {
      await load()
      return db!.versions
        .filter((item) => item.sectionId === sectionId)
        .sort((a, b) => a.versionNumber - b.versionNumber)
    },

    async get(id) {
      await load()
      return db!.versions.find((item) => item.id === id) ?? null
    },

    async nextVersionNumber(sectionId) {
      await load()
      const numbers = db!.versions
        .filter((item) => item.sectionId === sectionId)
        .map((item) => item.versionNumber)
      return numbers.length ? Math.max(...numbers) + 1 : 1
    },

    async create(input: CreateVersionInput) {
      await load()
      const versionNumber =
        input.versionNumber ?? (await version.nextVersionNumber(input.sectionId))
      const record: SectionVersion = {
        id: `ver_${randomUUID()}`,
        sectionId: input.sectionId,
        versionNumber,
        promptSnapshot: input.promptSnapshot ?? null,
        copySnapshot: input.copySnapshot ?? null,
        imageAssetId: input.imageAssetId ?? null,
        isActive: false,
        createdAt: now(),
      }
      db!.versions.push(record)
      await persist()
      return record
    },

    async setActive(sectionId, versionId) {
      await load()
      let activated: SectionVersion | null = null
      for (const record of db!.versions) {
        if (record.sectionId !== sectionId) continue
        record.isActive = record.id === versionId
        if (record.isActive) activated = record
      }
      if (!activated) throw new Error(`version not found in section: ${versionId}`)
      await persist()
      return activated
    },
  }

  // -- task ------------------------------------------------------------------

  const task: TaskRepository = {
    async create(input: CreateTaskInput) {
      await load()
      const timestamp = now()
      const status = input.status ?? 'RUNNING'
      const record: GenerationTask = {
        id: `tsk_${randomUUID()}`,
        projectId: input.projectId,
        sectionId: input.sectionId ?? null,
        taskType: input.taskType,
        status,
        inputPayload: input.inputPayload ?? null,
        outputPayload: input.outputPayload ?? null,
        errorMessage: null,
        startedAt: status === 'RUNNING' ? timestamp : null,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      db!.tasks.push(record)
      await persist()
      return record
    },

    async get(id) {
      await load()
      return db!.tasks.find((item) => item.id === id) ?? null
    },

    async update(id, patch) {
      await load()
      const record = db!.tasks.find((item) => item.id === id)
      if (!record) throw new Error(`task not found: ${id}`)
      if (patch.status !== undefined) record.status = patch.status
      if (patch.inputPayload !== undefined) record.inputPayload = patch.inputPayload
      if (patch.outputPayload !== undefined) record.outputPayload = patch.outputPayload
      if (patch.errorMessage !== undefined) record.errorMessage = patch.errorMessage
      if (patch.startedAt !== undefined) record.startedAt = patch.startedAt
      if (patch.completedAt !== undefined) record.completedAt = patch.completedAt
      record.updatedAt = now()
      await persist()
      return record
    },

    /** Terminal-state sticky — upstream relies on this for correctness. */
    async mergeProgress(id, patch) {
      await load()
      const record = db!.tasks.find((item) => item.id === id)
      if (!record || isTerminal(record.status)) return record ?? null
      record.outputPayload = { ...(record.outputPayload ?? {}), ...patch }
      record.updatedAt = now()
      await persist()
      return record
    },

    async list(projectId, limit) {
      await load()
      const items = db!.tasks
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      return limit ? items.slice(0, limit) : items
    },

    async findRecentRunning(filter: RunningTaskFilter) {
      await load()
      const maxAgeMinutes = filter.maxAgeMinutes ?? 10
      const startedAfter = Date.now() - maxAgeMinutes * 60_000
      const types = Array.isArray(filter.taskType) ? filter.taskType : [filter.taskType]
      const matches = db!.tasks
        .filter(
          (item) =>
            item.projectId === filter.projectId &&
            (item.sectionId ?? null) === (filter.sectionId ?? null) &&
            types.includes(item.taskType) &&
            item.status === 'RUNNING' &&
            !!item.startedAt &&
            item.startedAt.getTime() >= startedAfter,
        )
        .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0))
      return matches[0] ?? null
    },

    /**
     * Marks stale bulk GENERATE tasks FAILED. Never re-dispatches — upstream
     * only ever failed orphans after a restart.
     */
    async recoverStale(projectId, staleMs) {
      await load()
      const cutoff = Date.now() - staleMs
      const recovered: GenerationTask[] = []
      for (const record of db!.tasks) {
        if (record.projectId !== projectId) continue
        if (record.taskType !== 'GENERATE' || record.sectionId !== null) continue
        if (record.status !== 'PENDING' && record.status !== 'RUNNING') continue
        if (record.updatedAt.getTime() > cutoff) continue
        record.status = 'FAILED'
        record.completedAt = now()
        record.errorMessage =
          '批量生成后台执行已中断，系统已结束遗留任务，请重新生成未完成模块。'
        record.updatedAt = now()
        recovered.push(record)
      }
      if (recovered.length) await persist()
      return recovered
    },
  }

  return {
    project,
    asset,
    analysis,
    section,
    version,
    task,
    async close() {
      await writeChain
    },
  }
}
