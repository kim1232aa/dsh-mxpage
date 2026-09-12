/**
 * Host implementation of the StorageDriver port: a filesystem root under
 * `$DSH_HOME/mxpage`, with `publicUrl()` returning `null` because a DSH plugin
 * has no HTTP file route. Callers fall back to base64 attachments.
 */

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { normalizeRelPath, type StorageDriver } from '../core/ports/storage.ts'

function toAbsolute(root: string, relPath: string): string {
  const normalized = normalizeRelPath(relPath)
  const absolute = path.resolve(root, normalized)
  const relative = path.relative(root, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path escapes storage root: ${relPath}`)
  }
  return absolute
}

export function createFileStorageDriver(rootDir: string): StorageDriver {
  const root = path.resolve(rootDir)

  return {
    rootDir: () => root,

    async read(relPath) {
      return fs.readFile(toAbsolute(root, relPath))
    },

    async write(relPath, data) {
      const absolute = toAbsolute(root, relPath)
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, data)
    },

    async stat(relPath) {
      try {
        const info = await fs.stat(toAbsolute(root, relPath))
        return { size: info.size, mtimeMs: info.mtimeMs }
      } catch {
        return null
      }
    },

    async exists(relPath) {
      try {
        await fs.access(toAbsolute(root, relPath))
        return true
      } catch {
        return false
      }
    },

    async remove(relPath) {
      await fs.rm(toAbsolute(root, relPath), { force: true })
    },

    async removeDir(relDir) {
      await fs.rm(toAbsolute(root, relDir), { recursive: true, force: true })
    },

    async ensureDir(relDir) {
      await fs.mkdir(toAbsolute(root, relDir), { recursive: true })
    },

    async list(relDir) {
      const absolute = toAbsolute(root, relDir)
      if (!existsSync(absolute)) return []
      const out: string[] = []
      async function walk(dir: string) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) await walk(full)
          else out.push(path.relative(root, full).split(path.sep).join('/'))
        }
      }
      await walk(absolute)
      return out.sort()
    },

    /** No HTTP file route inside a DSH plugin — attachments are the channel. */
    publicUrl() {
      return null
    },
  }
}
