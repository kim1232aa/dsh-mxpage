/**
 * Port: StorageDriver.
 *
 * Replaces upstream's `process.cwd()`-rooted filesystem access, which appears
 * in exactly three places:
 *   - `lib/storage/asset-manager.ts`  → `path.resolve(process.cwd(), env.STORAGE_ROOT)`
 *   - `lib/services/workflow-task-service.ts` → `task-inputs/<taskId>/`
 *   - `lib/services/export-service.ts` → `tmp-export-<id>.zip` in cwd
 *
 * Paths handed to this port are always POSIX-relative to the storage root.
 */

export interface StorageDriver {
  /** Absolute path of the storage root (host-owned). */
  rootDir(): string
  read(relPath: string): Promise<Buffer>
  write(relPath: string, data: Buffer): Promise<void>
  /** Returns null when the file does not exist. */
  stat(relPath: string): Promise<{ size: number; mtimeMs: number } | null>
  exists(relPath: string): Promise<boolean>
  remove(relPath: string): Promise<void>
  removeDir(relDir: string): Promise<void>
  ensureDir(relDir: string): Promise<void>
  /** Recursive file listing, POSIX-relative to the storage root. */
  list(relDir: string): Promise<string[]>
  /**
   * Maps a storage-relative path to something a browser can render.
   * Upstream returned `/api/files/<path>`; a headless host returns `null`
   * and callers fall back to base64 attachments.
   */
  publicUrl(relPath: string): string | null
}

/** POSIX-normalizes a storage-relative path and rejects escapes. */
export function normalizeRelPath(relPath: string): string {
  const posix = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments: string[] = []
  for (const segment of posix.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error(`path escapes storage root: ${relPath}`)
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  if (segments.length === 0) throw new Error(`invalid storage path: ${relPath}`)
  return segments.join('/')
}
