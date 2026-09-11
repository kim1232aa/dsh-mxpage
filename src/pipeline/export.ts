import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { crc32 } from 'node:zlib'
import { listOutputSections } from './generate.ts'
import type { ProjectStore } from '../service/project-store.ts'
import { assertInside } from '../util/paths.ts'
import { redactSecrets } from '../util/redact.ts'

export type ExportFormat = 'paths' | 'zip'

export interface ExportPageArgs {
  projectId: string
  format?: ExportFormat
}

export interface ExportPageOk {
  ok: true
  format: ExportFormat
  files: string[]
  zipPath?: string
  [key: string]: string | number | boolean | string[] | undefined
}

export interface ExportPageFail {
  ok: false
  error: string
  [key: string]: string | number | boolean
}

export type ExportPageResult = ExportPageOk | ExportPageFail

export interface ExportPageDeps {
  store: ProjectStore
}

function fail(error: string): ExportPageFail {
  return { ok: false, error: redactSecrets(error) }
}

function u16(n: number): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt16LE(n & 0xffff)
  return buf
}

function u32(n: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(n >>> 0)
  return buf
}

function zipEntryName(absPath: string): string {
  const name = basename(absPath)
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`invalid zip entry name: ${name}`)
  }
  return name
}

/** Minimal ZIP (STORE) using node:zlib crc32. No extra deps. */
export function writeStoreZip(zipPath: string, entries: Array<{ name: string; data: Buffer }>): void {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const crc = crc32(data) >>> 0
    const size = data.length
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ])
    locals.push(local, data)
    centrals.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]))
    offset += local.length + data.length
  }
  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ])
  writeFileSync(zipPath, Buffer.concat([...locals, centralDir, eocd]))
}

export function exportPage(deps: ExportPageDeps, args: ExportPageArgs): ExportPageResult {
  let record
  try {
    record = deps.store.read(args.projectId)
  } catch {
    return fail('MXPAGE_NOT_FOUND')
  }

  const format: ExportFormat = args.format ?? 'paths'
  if (format !== 'paths' && format !== 'zip') {
    return fail('invalid format')
  }

  try {
    const projectDir = record.workspaceDir
    const sections = listOutputSections(projectDir)
    const files = sections.map((section) => section.outputPath)
    if (format === 'paths') {
      return { ok: true, format, files }
    }

    const outputDir = assertInside(projectDir, join(projectDir, 'output'))
    mkdirSync(outputDir, { recursive: true })
    const iso = new Date().toISOString().replace(/[:.]/g, '-')
    const zipPath = assertInside(projectDir, join(outputDir, `export-${iso}.zip`))

    const zipEntries: Array<{ name: string; data: Buffer }> = []
    for (const section of sections) {
      const abs = assertInside(projectDir, section.outputPath)
      if (!existsSync(abs)) continue
      zipEntries.push({ name: zipEntryName(abs), data: readFileSync(abs) })
    }
    const analysisPath = assertInside(projectDir, join(projectDir, 'analysis.json'))
    if (existsSync(analysisPath)) {
      zipEntries.push({ name: 'analysis.json', data: readFileSync(analysisPath) })
    }
    writeStoreZip(zipPath, zipEntries)
    return { ok: true, format, files, zipPath }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fail(message)
  }
}
