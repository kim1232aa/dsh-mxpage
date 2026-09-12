/**
 * Asset store — the storage + persistence seam for product images.
 *
 * Ported from upstream `lib/storage/asset-manager.ts` (ziguishian/MxPage, MIT).
 *
 * Changes made during the DSH port:
 *  - `rootDir()` (`path.resolve(process.cwd(), env.STORAGE_ROOT)`) → injected
 *    StorageDriver. `process.cwd()` is the host's cwd in a plugin, not the app's.
 *  - `prisma.productAsset.*` → injected Repository.
 *  - `nanoid` → `node:crypto` (drops a dependency).
 *  - Stored `filePath` is now always POSIX. Upstream built it with `path.join`,
 *    so on Windows the DB held backslashes while the URL builder converted them
 *    back with `split(path.sep)` — an OS-dependent round trip.
 */

import { randomBytes } from 'node:crypto'

import type { CoreHost } from '../ports/index.ts'
import { normalizeRelPath } from '../ports/storage.ts'
import type { AssetType, ProductAsset } from '../types/domain.ts'
import { extFromMime, sanitizeFileName } from '../utils/files.ts'

export const STORAGE_DIRS = {
  uploads: 'uploads',
  generated: 'generated',
  exports: 'exports',
  taskInputs: 'task-inputs',
} as const

function suffix(bytes = 6): string {
  return randomBytes(bytes).toString('hex').slice(0, bytes * 2)
}

function toPosix(...segments: string[]): string {
  return normalizeRelPath(segments.filter(Boolean).join('/'))
}

export interface AssetStore {
  ensureScaffold(): Promise<void>
  saveUploadAsset(params: {
    projectId: string
    type: AssetType
    fileName: string
    mimeType?: string | null
    fileBuffer: Buffer
    sortOrder: number
    isMain?: boolean
  }): Promise<ProductAsset>
  saveGeneratedImage(params: {
    projectId: string
    sectionId: string
    prompt: string
    source: {
      url?: string | null
      b64Json?: string | null
      svgText?: string | null
      mimeType?: string | null
    }
    metadata?: Record<string, unknown>
  }): Promise<ProductAsset>
  duplicateExportFile(params: {
    projectId: string
    fileName: string
    sourceBuffer: Buffer
    mimeType: string
  }): Promise<ProductAsset>
  deleteAssetRecord(assetId: string): Promise<ProductAsset | null>
  /** Browser-renderable URL, or null in a headless host. */
  assetPublicUrl(asset: Pick<ProductAsset, 'filePath'> | null | undefined): string | null
  readStorageFile(relativePath: string): Promise<Buffer>
  statStorageFile(relativePath: string): Promise<{ size: number; mtimeMs: number } | null>
  /** Absolute path for a storage-relative path (for hosts that need one). */
  absolutePath(relativePath: string): string
  removeProjectDirs(projectId: string): Promise<void>
  /** Stages uploaded bytes for a batch/workflow task. */
  stageTaskInput(taskId: string, index: number, fileName: string, data: Buffer): Promise<string>
  listTaskInputs(taskId: string): Promise<string[]>
}

export function createAssetStore(host: CoreHost): AssetStore {
  const { repository, storage } = host

  function projectDir(kind: string, projectId: string, sectionId?: string): string {
    return toPosix(kind, projectId, sectionId ?? '')
  }

  async function ensureScaffold(): Promise<void> {
    await Promise.all([
      storage.ensureDir(STORAGE_DIRS.uploads),
      storage.ensureDir(STORAGE_DIRS.generated),
      storage.ensureDir(STORAGE_DIRS.exports),
    ])
  }

  async function deleteAssetRecord(assetId: string): Promise<ProductAsset | null> {
    const asset = await repository.asset.get(assetId)
    if (!asset) return null
    await storage.remove(asset.filePath).catch(() => undefined)
    await repository.asset.delete(assetId)
    return asset
  }

  return {
    ensureScaffold,
    deleteAssetRecord,

    async saveUploadAsset(params) {
      await ensureScaffold()
      const safeName = `${Date.now()}-${suffix()}-${sanitizeFileName(params.fileName)}`
      const relativePath = toPosix(STORAGE_DIRS.uploads, params.projectId, safeName)
      await storage.write(relativePath, params.fileBuffer)

      return repository.asset.create({
        projectId: params.projectId,
        type: params.type,
        filePath: relativePath,
        fileName: params.fileName,
        mimeType: params.mimeType ?? null,
        sortOrder: params.sortOrder,
        isMain: params.isMain ?? false,
        metadata: { bytes: params.fileBuffer.byteLength },
      })
    },

    async saveGeneratedImage(params) {
      await ensureScaffold()

      const mimeType = params.source.svgText
        ? 'image/svg+xml'
        : (params.source.mimeType ?? 'image/png')
      const ext = extFromMime(mimeType)
      const fileName = `${Date.now()}-${suffix()}.${ext}`
      const relativePath = toPosix(
        STORAGE_DIRS.generated,
        params.projectId,
        params.sectionId,
        fileName,
      )

      if (params.source.svgText) {
        await storage.write(relativePath, Buffer.from(params.source.svgText, 'utf8'))
      } else if (params.source.b64Json) {
        await storage.write(relativePath, Buffer.from(params.source.b64Json, 'base64'))
      } else if (params.source.url) {
        const response = await fetch(params.source.url)
        if (!response.ok) {
          throw new Error(`Failed to download generated image: ${response.status}`)
        }
        await storage.write(relativePath, Buffer.from(await response.arrayBuffer()))
      } else {
        throw new Error('Image generation produced no usable image output.')
      }

      return repository.asset.create({
        projectId: params.projectId,
        sectionId: params.sectionId,
        type: 'GENERATED',
        filePath: relativePath,
        fileName,
        mimeType,
        sortOrder: 0,
        isMain: false,
        metadata: { prompt: params.prompt, ...(params.metadata ?? {}) },
      })
    },

    async duplicateExportFile(params) {
      await ensureScaffold()
      const ext = extFromMime(params.mimeType)
      const safeName = sanitizeFileName(`${params.fileName}.${ext}`)
      const relativePath = toPosix(STORAGE_DIRS.exports, params.projectId, safeName)
      await storage.write(relativePath, params.sourceBuffer)

      return repository.asset.create({
        projectId: params.projectId,
        type: 'EXPORTED',
        filePath: relativePath,
        fileName: safeName,
        mimeType: params.mimeType,
        sortOrder: 0,
        isMain: false,
      })
    },

    assetPublicUrl(asset) {
      if (!asset) return null
      return storage.publicUrl(asset.filePath)
    },

    readStorageFile(relativePath) {
      return storage.read(normalizeRelPath(relativePath))
    },

    statStorageFile(relativePath) {
      return storage.stat(normalizeRelPath(relativePath))
    },

    absolutePath(relativePath) {
      const normalized = normalizeRelPath(relativePath)
      return `${storage.rootDir().replace(/[\\/]+$/, '')}/${normalized}`
    },

    async removeProjectDirs(projectId) {
      await Promise.all(
        [STORAGE_DIRS.uploads, STORAGE_DIRS.generated, STORAGE_DIRS.exports].map((kind) =>
          storage.removeDir(toPosix(kind, projectId)).catch(() => undefined),
        ),
      )
    },

    async stageTaskInput(taskId, index, fileName, data) {
      const relativePath = toPosix(
        STORAGE_DIRS.taskInputs,
        taskId,
        `${String(index).padStart(2, '0')}-${sanitizeFileName(fileName)}`,
      )
      await storage.write(relativePath, data)
      return relativePath
    },

    async listTaskInputs(taskId) {
      return storage.list(toPosix(STORAGE_DIRS.taskInputs, taskId))
    },
  }
}
