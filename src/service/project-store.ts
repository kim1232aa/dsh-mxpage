import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { assertInside } from '../util/paths.ts'
import { assertTransition, type STATUS } from './state-machine.ts'

export type AssetRole = 'main' | 'angle' | 'detail' | 'reference'
export type ContentLanguage = 'zh-CN' | 'en' | 'ja' | 'ko'
export type AspectRatio = '1:1' | '3:4' | '9:16'

export interface ProjectRecord {
  id: string
  name: string
  status: string
  language: ContentLanguage
  aspectRatio: AspectRatio
  mainAssetPath: string
  assets: { path: string; role: AssetRole }[]
  workspaceDir: string
}

export interface CreateInput {
  name?: string
  imagePaths: string[]
  mainImagePath?: string
  language?: ContentLanguage
  aspectRatio?: AspectRatio
}

export interface ProjectStore {
  create(input: CreateInput): ProjectRecord
  addAsset(projectId: string, absImagePath: string, role: AssetRole): ProjectRecord
  read(projectId: string): ProjectRecord
  write(projectId: string, patch: Partial<ProjectRecord>): ProjectRecord
  projectDir(projectId: string): string
}

const MAX_ASSETS = 10

function assertExistingFile(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`image file not found: ${path}`)
  }
}

function uniqueBasename(dir: string, name: string): string {
  const ext = extname(name)
  const stem = basename(name, ext)
  let candidate = name
  let n = 1
  while (existsSync(join(dir, candidate))) {
    candidate = `${stem}-${n}${ext}`
    n += 1
  }
  return candidate
}

export function createStore(rootDir: string): ProjectStore {
  function projectDir(projectId: string): string {
    return assertInside(rootDir, join(rootDir, 'projects', projectId))
  }

  function persist(record: ProjectRecord): void {
    const dir = projectDir(record.id)
    const file = assertInside(dir, join(dir, 'project.json'))
    writeFileSync(file, JSON.stringify(record, null, 2))
  }

  function copyIntoAssets(dir: string, absImagePath: string): string {
    assertExistingFile(absImagePath)
    const assetsDir = join(dir, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    const dest = assertInside(dir, join(assetsDir, uniqueBasename(assetsDir, basename(absImagePath))))
    copyFileSync(absImagePath, dest)
    return dest
  }

  function read(projectId: string): ProjectRecord {
    const dir = projectDir(projectId)
    const file = assertInside(dir, join(dir, 'project.json'))
    if (!existsSync(file)) {
      throw new Error(`project not found: ${projectId}`)
    }
    return JSON.parse(readFileSync(file, 'utf8')) as ProjectRecord
  }

  function create(input: CreateInput): ProjectRecord {
    const imagePaths = input.imagePaths
    if (!Array.isArray(imagePaths) || imagePaths.length < 1 || imagePaths.length > MAX_ASSETS) {
      throw new Error('imagePaths required (1–10 existing files)')
    }
    for (const src of imagePaths) assertExistingFile(src)

    const mainSrc = resolve(input.mainImagePath ?? imagePaths[0])
    if (!imagePaths.some((src) => resolve(src) === mainSrc)) {
      throw new Error('mainImagePath is not in imagePaths')
    }

    const id = `mxp_${randomUUID()}`
    const dir = projectDir(id)

    const assets: ProjectRecord['assets'] = []
    let mainAssetPath = ''
    for (const src of imagePaths) {
      const dest = copyIntoAssets(dir, src)
      const role: AssetRole = resolve(src) === mainSrc ? 'main' : 'reference'
      assets.push({ path: dest, role })
      if (role === 'main') mainAssetPath = dest
    }

    const record: ProjectRecord = {
      id,
      name: input.name ?? 'untitled',
      status: 'created',
      language: input.language ?? 'zh-CN',
      aspectRatio: input.aspectRatio ?? '3:4',
      mainAssetPath,
      assets,
      workspaceDir: dir,
    }
    persist(record)
    return record
  }

  function addAsset(projectId: string, absImagePath: string, role: AssetRole): ProjectRecord {
    const rec = read(projectId)
    if (rec.assets.length >= MAX_ASSETS) {
      throw new Error('max 10 assets')
    }
    const dest = copyIntoAssets(projectDir(projectId), absImagePath)
    if (role === 'main') {
      for (const asset of rec.assets) {
        if (asset.role === 'main') asset.role = 'reference'
      }
      rec.mainAssetPath = dest
    }
    rec.assets.push({ path: dest, role })
    persist(rec)
    return rec
  }

  function write(projectId: string, patch: Partial<ProjectRecord>): ProjectRecord {
    const current = read(projectId)
    if (patch.status !== undefined) {
      assertTransition(current.status as STATUS, patch.status as STATUS)
    }
    const next: ProjectRecord = { ...current, ...patch, id: current.id }
    persist(next)
    return next
  }

  return { create, addAsset, read, write, projectDir }
}
