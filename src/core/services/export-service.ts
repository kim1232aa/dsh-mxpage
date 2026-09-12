/**
 * Export service — project JSON export and the detail-page image archive.
 *
 * Ported from upstream `lib/services/export-service.ts` (ziguishian/MxPage, MIT).
 *
 * Changes made during the DSH port:
 *  - `prisma.project.findUnique({ include: ... })` → `repository.project.getDetail(id)`.
 *    Both upstream queries collapse into that one aggregate read: `assets`,
 *    `analysis` and `sections.versions` come back on it, and each section's
 *    `currentImageAsset` relation is re-resolved locally from `detail.assets`
 *    (the repository exposes `currentImageAssetId` only). The upstream
 *    `orderBy` clauses are re-applied in memory because the port does not
 *    promise an ordering for the aggregate.
 *  - `archiver` streaming into `path.join(process.cwd(), 'tmp-export-<id>.zip')`
 *    → the in-memory `createZip` from `../utils/zip.ts`, written once through
 *    `storage.write('exports/<projectId>/<name>.zip')`. No dependency, no temp
 *    file, no absolute path, no `process.cwd()`.
 *  - `readStorageFile` → `assetStore.readStorageFile`.
 *  - `createTask` / `findRecentRunningTask` / `completeTask` / `failTask` →
 *    the injected TaskService (upstream imported the same functions).
 *  - `buildImageArchive` returns an archive descriptor (`zipPath`, `buffer`,
 *    counts, manifest) instead of a bare `Buffer`: a headless host has no HTTP
 *    response to stream into and needs the storage path. `.buffer` is exactly
 *    the upstream return value.
 *
 * Preserved deliberately (product value — do not "fix"):
 *  - the archive shape: `00-头图/`, `01-详情页/`, `export-manifest.json`,
 *    `mx_<timestamp>_<NN>.<ext>`, and the selection logic of
 *    `buildGalleryAssets` (HERO sections + MAIN/ANGLE assets, deduped on
 *    `filePath`) and `buildDetailAssets` (non-HERO sections that have an image);
 *  - every user-facing string, verbatim;
 *  - `getPreviewConfig` lets a non-numeric count through as `NaN`
 *    (`Number('abc')` → `Math.max(1, NaN)` → `NaN` → `slice(0, NaN)` → empty
 *    gallery). Upstream behaves the same way;
 *  - an unknown section type falls back to `section.sectionKey`. This is why
 *    the label lookup below is a raw `toLowerCase()` instead of the port's
 *    `toSectionTypeKey`, which coerces unknown types to `'custom'`.
 */

import { posix as posixPath } from 'node:path'

import type { CoreHost } from '../ports/index.ts'
import { normalizeRelPath } from '../ports/storage.ts'
import type {
  ModelSnapshot,
  PageSectionWithVersions,
  ProductAsset,
  ProjectDetail,
  SectionType,
  SectionTypeKey,
} from '../types/domain.ts'
import { assetTypeLabels, sectionTypeLabels } from '../types/domain.ts'
import {
  contentLanguageLabels,
  normalizeContentLanguage,
  type ContentLanguage,
} from '../utils/content-language.ts'
import { extFromMime } from '../utils/files.ts'
import { createZip, type ZipEntry } from '../utils/zip.ts'
import { STORAGE_DIRS, createAssetStore, type AssetStore } from './asset-store.ts'
import { createTaskService, type TaskService } from './task-service.ts'

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

export interface ExportPreviewConfig {
  heroImageCount: number
  detailSectionCount: number
  imageAspectRatio: '3:4' | '9:16'
  contentLanguage: ContentLanguage
}

export interface ExportManifestImageEntry {
  order: number
  title: string
  sourceLabel: string
  fileName: string
  originalFileName: string
  zipPath: string
  mimeType?: string | null
}

export interface ExportManifestDetailEntry extends ExportManifestImageEntry {
  sectionKey: string
  sectionType: SectionType
}

/** Content of the `export-manifest.json` entry. */
export interface ExportManifest {
  projectId: string
  projectName: string
  exportedAt: string
  exportTimestamp: number
  heroImageCount: number
  detailImageCount: number
  previewConfig: ExportPreviewConfig
  outputLanguageLabel: string
  gallery: ExportManifestImageEntry[]
  details: ExportManifestDetailEntry[]
}

/** What `buildImageArchive` produces and stores. */
export interface ExportArchive {
  /** Storage-relative path of the written archive (`exports/<projectId>/<name>.zip`). */
  zipPath: string
  fileName: string
  mimeType: 'application/zip'
  byteLength: number
  /** The archive bytes — the upstream return value. */
  buffer: Buffer
  exportTimestamp: number
  heroImageCount: number
  detailImageCount: number
  manifest: ExportManifest
}

// ---------------------------------------------------------------------------
// Project shape the two builders read
// ---------------------------------------------------------------------------

/** A section with its `currentImageAsset` relation resolved. */
export interface ArchiveSection extends PageSectionWithVersions {
  currentImageAsset: ProductAsset | null
}

type ArchiveSectionWithImage = ArchiveSection & { currentImageAsset: ProductAsset }

export interface ArchiveProject extends ProjectDetail {
  assets: ProductAsset[]
  sections: ArchiveSection[]
}

// ---------------------------------------------------------------------------
// Pure helpers (upstream module-private, kept module-private)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getPreviewConfig(
  project: { modelSnapshot?: ModelSnapshot | null } | null,
): ExportPreviewConfig {
  const snapshot = asRecord(project?.modelSnapshot)
  const config = asRecord(snapshot.previewConfig)

  return {
    heroImageCount: Math.min(5, Math.max(1, Number(config.heroImageCount ?? 4))),
    detailSectionCount: Math.min(10, Math.max(1, Number(config.detailSectionCount ?? 6))),
    imageAspectRatio: config.imageAspectRatio === '3:4' ? '3:4' : '9:16',
    contentLanguage: normalizeContentLanguage(config.contentLanguage),
  }
}

function buildGalleryAssets(project: {
  assets: ProductAsset[]
  sections: ArchiveSection[]
  modelSnapshot?: ModelSnapshot | null
}) {
  const previewConfig = getPreviewConfig(project)
  const uploadedAssets = project.assets.filter((asset) => ['MAIN', 'ANGLE'].includes(asset.type))
  const heroSectionAssets = project.sections
    .filter(
      (section): section is ArchiveSectionWithImage =>
        section.type === 'HERO' && Boolean(section.currentImageAsset),
    )
    .map((section, index) => ({
      asset: section.currentImageAsset,
      title: section.title || `头图 ${index + 1}`,
      sourceLabel: '头图规划',
    }))

  const merged = [
    ...heroSectionAssets,
    ...uploadedAssets.map((asset) => ({
      asset,
      title: asset.fileName,
      sourceLabel: assetTypeLabels[asset.type] ?? asset.type,
    })),
  ]

  const unique = merged.filter(
    (item, index, list) =>
      item.asset?.filePath && list.findIndex((entry) => entry.asset?.filePath === item.asset?.filePath) === index,
  )

  const plannedHeroCount = project.sections.filter((section) => section.type === 'HERO').length
  return unique.slice(0, Math.max(previewConfig.heroImageCount, plannedHeroCount))
}

/**
 * Upstream looked the label up by `section.type.toLowerCase()` and fell back to
 * `sectionKey`. `toSectionTypeKey` would return `'custom'` for an unknown type,
 * which is a different (visible) manifest value, so the raw lookup is kept.
 */
function sectionTypeLabel(section: Pick<ArchiveSection, 'type' | 'sectionKey'>): string {
  const key = section.type.toLowerCase() as SectionTypeKey
  return sectionTypeLabels[key] ?? section.sectionKey
}

function buildDetailAssets(project: { sections: ArchiveSection[] }) {
  return project.sections
    .filter((section) => section.type !== 'HERO')
    .filter((section): section is ArchiveSectionWithImage => Boolean(section.currentImageAsset))
    .map((section) => ({
      section,
      asset: section.currentImageAsset,
      sourceLabel: sectionTypeLabel(section),
    }))
}

const EXPORT_HERO_DIR = '00-头图'
const EXPORT_DETAIL_DIR = '01-详情页'
const EXPORT_MANIFEST_ENTRY = 'export-manifest.json'

function buildExportImageFileName(exportTimestamp: number, index: number, ext: string) {
  const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`
  return `mx_${exportTimestamp}_${String(index + 1).padStart(2, '0')}${normalizedExt}`
}

/** Upstream used OS-dependent `path.extname`; storage paths are POSIX here. */
function exportImageExt(asset: Pick<ProductAsset, 'fileName' | 'mimeType'>): string {
  return posixPath.extname(asset.fileName) || `.${extFromMime(asset.mimeType)}`
}

function exportEntryPath(
  directory: string,
  exportTimestamp: number,
  index: number,
  asset: Pick<ProductAsset, 'fileName' | 'mimeType'>,
): string {
  return `${directory}/${buildExportImageFileName(exportTimestamp, index, exportImageExt(asset))}`
}

/** Upstream `orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }]`. */
function compareArchiveAssets(left: ProductAsset, right: ProductAsset): number {
  if (left.isMain !== right.isMain) return left.isMain ? -1 : 1
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder
  return left.createdAt.getTime() - right.createdAt.getTime()
}

/** Upstream `orderBy: { order: 'asc' }` with `versions: { versionNumber: 'desc' }`. */
function sortSections(
  sections: readonly PageSectionWithVersions[],
): PageSectionWithVersions[] {
  return [...sections]
    .sort((left, right) => left.order - right.order)
    .map((section) => ({
      ...section,
      versions: [...(section.versions ?? [])].sort(
        (left, right) => right.versionNumber - left.versionNumber,
      ),
    }))
}

/** Folds the upstream `include: { currentImageAsset: true, ... }` graph back in. */
function resolveArchiveProject(detail: ProjectDetail): ArchiveProject {
  const assets = [...detail.assets].sort(compareArchiveAssets)
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]))

  return {
    ...detail,
    assets,
    sections: sortSections(detail.sections).map((section) => ({
      ...section,
      currentImageAsset: section.currentImageAssetId
        ? (assetsById.get(section.currentImageAssetId) ?? null)
        : null,
    })),
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ExportServiceDeps {
  /** Defaults to `createAssetStore(host)`. */
  assetStore?: Pick<AssetStore, 'ensureScaffold' | 'readStorageFile'>
  /** Defaults to `createTaskService(host)`. */
  taskService?: Pick<
    TaskService,
    'createTask' | 'findRecentRunningTask' | 'completeTask' | 'failTask'
  >
}

export interface ExportService {
  /** Upstream `buildProjectJson` — the whole project graph, for JSON export. */
  buildProjectJson(projectId: string): Promise<ProjectDetail>
  /** Upstream `buildImageArchive` — builds the ZIP and stores it under `exports/`. */
  buildImageArchive(projectId: string): Promise<ExportArchive>
}

export function createExportService(
  host: CoreHost,
  deps: ExportServiceDeps = {},
): ExportService {
  const { repository, storage } = host
  const assetStore: Pick<AssetStore, 'ensureScaffold' | 'readStorageFile'> =
    deps.assetStore ?? createAssetStore(host)
  const taskService: Pick<
    TaskService,
    'createTask' | 'findRecentRunningTask' | 'completeTask' | 'failTask'
  > = deps.taskService ?? createTaskService(host)

  async function loadArchiveProject(projectId: string): Promise<ArchiveProject> {
    const detail = await repository.project.getDetail(projectId)
    if (!detail) {
      throw new Error('Project not found.')
    }

    return resolveArchiveProject(detail)
  }

  return {
    async buildProjectJson(projectId) {
      const project = await repository.project.getDetail(projectId)

      if (!project) {
        throw new Error('Project not found.')
      }

      return { ...project, sections: sortSections(project.sections) }
    },

    async buildImageArchive(projectId) {
      const project = await loadArchiveProject(projectId)

      const existingTask = await taskService.findRecentRunningTask({
        projectId,
        taskType: 'EXPORT',
        maxAgeMinutes: 10,
      })
      if (existingTask) {
        throw new Error('当前导出任务仍在进行中，请等待这一轮完成后再试。')
      }

      const task = await taskService.createTask({
        projectId,
        taskType: 'EXPORT',
        inputPayload: { type: 'detail-page-images' },
      })

      try {
        const exportTimestamp = Date.now()

        const galleryAssets = buildGalleryAssets(project)
        const detailAssets = buildDetailAssets(project)

        // Upstream appended into a stream as the reads resolved; entry order is
        // heroes, then details, then the manifest.
        const [galleryEntries, detailEntries] = await Promise.all([
          Promise.all(
            galleryAssets.map(
              async (item, index): Promise<ZipEntry> => ({
                name: exportEntryPath(EXPORT_HERO_DIR, exportTimestamp, index, item.asset),
                data: await assetStore.readStorageFile(item.asset.filePath),
              }),
            ),
          ),
          Promise.all(
            detailAssets.map(
              async (item, index): Promise<ZipEntry> => ({
                name: exportEntryPath(EXPORT_DETAIL_DIR, exportTimestamp, index, item.asset),
                data: await assetStore.readStorageFile(item.asset.filePath),
              }),
            ),
          ),
        ])

        const manifest: ExportManifest = {
          projectId: project.id,
          projectName: project.name,
          exportedAt: new Date().toISOString(),
          exportTimestamp,
          heroImageCount: galleryAssets.length,
          detailImageCount: detailAssets.length,
          previewConfig: getPreviewConfig(project),
          outputLanguageLabel: contentLanguageLabels[getPreviewConfig(project).contentLanguage],
          gallery: galleryAssets.map((item, index) => ({
            order: index + 1,
            title: item.title,
            sourceLabel: item.sourceLabel,
            fileName: buildExportImageFileName(
              exportTimestamp,
              index,
              exportImageExt(item.asset),
            ),
            originalFileName: item.asset.fileName,
            zipPath: exportEntryPath(EXPORT_HERO_DIR, exportTimestamp, index, item.asset),
            mimeType: item.asset.mimeType,
          })),
          details: detailAssets.map((item, index) => ({
            order: index + 1,
            sectionKey: item.section.sectionKey,
            title: item.section.title,
            sectionType: item.section.type,
            sourceLabel: item.sourceLabel,
            fileName: buildExportImageFileName(
              exportTimestamp,
              index,
              exportImageExt(item.asset),
            ),
            originalFileName: item.asset.fileName,
            zipPath: exportEntryPath(EXPORT_DETAIL_DIR, exportTimestamp, index, item.asset),
            mimeType: item.asset.mimeType,
          })),
        }

        const zipBuffer = createZip(
          [
            ...galleryEntries,
            ...detailEntries,
            { name: EXPORT_MANIFEST_ENTRY, data: JSON.stringify(manifest, null, 2) },
          ],
          { level: 9 },
        )

        const fileName = `mx_${exportTimestamp}_detail-page-images.zip`
        const zipPath = normalizeRelPath(`${STORAGE_DIRS.exports}/${projectId}/${fileName}`)
        await assetStore.ensureScaffold()
        await storage.write(zipPath, zipBuffer)

        await taskService.completeTask(task.id, {
          exportedHeroImages: galleryAssets.length,
          exportedDetailImages: detailAssets.length,
        })

        return {
          zipPath,
          fileName,
          mimeType: 'application/zip',
          byteLength: zipBuffer.byteLength,
          buffer: zipBuffer,
          exportTimestamp,
          heroImageCount: galleryAssets.length,
          detailImageCount: detailAssets.length,
          manifest,
        }
      } catch (error) {
        await taskService.failTask(
          task.id,
          error instanceof Error ? error.message : 'Export failed',
        )
        throw error
      }
    },
  }
}
