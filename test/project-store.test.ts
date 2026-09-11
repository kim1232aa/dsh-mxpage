import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createStore } from '../src/service/project-store.ts'

// 1×1 PNG (valid file; no network)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function withStore(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), 'mxpage-store-'))
  const rootDir = join(tmp, 'workspace')
  const srcDir = join(tmp, 'src')
  mkdirSync(rootDir)
  mkdirSync(srcDir)
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  return {
    rootDir,
    tmp,
    store: createStore(rootDir),
    png(name: string) {
      const p = join(srcDir, name)
      writeFileSync(p, PNG)
      return p
    },
  }
}

test('create copies images (does not move)', (t) => {
  const { rootDir, store, png } = withStore(t)
  const src = png('main.png')
  const rec = store.create({ imagePaths: [src] })

  assert.ok(existsSync(src), 'source still exists after create')
  assert.ok(readFileSync(src).equals(PNG))
  const dest = join(rootDir, 'projects', rec.id, 'assets', 'main.png')
  assert.equal(rec.mainAssetPath, dest)
  assert.ok(existsSync(dest))
  assert.ok(readFileSync(dest).equals(PNG))
  assert.equal(rec.workspaceDir, join(rootDir, 'projects', rec.id))
  assert.equal(rec.status, 'created')
  assert.equal(rec.name, 'untitled')
  assert.equal(rec.language, 'zh-CN')
  assert.equal(rec.aspectRatio, '3:4')
  assert.match(rec.id, /^mxp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.equal(createStore(rootDir).read(rec.id).id, rec.id)
})

test('default main is the first image', (t) => {
  const { store, png } = withStore(t)
  const a = png('a.png')
  const b = png('b.png')
  const rec = store.create({ imagePaths: [a, b] })
  assert.equal(basename(rec.mainAssetPath), 'a.png')
  assert.equal(rec.assets[0]?.role, 'main')
  assert.equal(rec.assets[1]?.role, 'reference')
})

test('explicit mainImagePath selects that copy as main', (t) => {
  const { store, png } = withStore(t)
  const a = png('a.png')
  const b = png('b.png')
  const rec = store.create({ imagePaths: [a, b], mainImagePath: b })
  assert.equal(basename(rec.mainAssetPath), 'b.png')
})

test('role=main required to replace main', (t) => {
  const { store, png } = withStore(t)
  const rec = store.create({ imagePaths: [png('main.png')] })
  const orig = rec.mainAssetPath

  const angled = store.addAsset(rec.id, png('angle.png'), 'angle')
  assert.equal(angled.mainAssetPath, orig)

  const detailed = store.addAsset(rec.id, png('detail.png'), 'detail')
  assert.equal(detailed.mainAssetPath, orig)

  const referenced = store.addAsset(rec.id, png('ref.png'), 'reference')
  assert.equal(referenced.mainAssetPath, orig)

  const replaced = store.addAsset(rec.id, png('new-main.png'), 'main')
  assert.notEqual(replaced.mainAssetPath, orig)
  assert.equal(basename(replaced.mainAssetPath), 'new-main.png')
})

test('addAsset role=main demotes previous main to reference', (t) => {
  const { store, png } = withStore(t)
  const rec = store.create({ imagePaths: [png('main.png'), png('other.png')] })
  const orig = rec.mainAssetPath
  assert.equal(rec.assets.filter((a) => a.role === 'main').length, 1)

  const replaced = store.addAsset(rec.id, png('new-main.png'), 'main')
  const mains = replaced.assets.filter((a) => a.role === 'main')
  assert.equal(mains.length, 1, 'exactly one asset keeps role main')
  assert.equal(mains[0]?.path, replaced.mainAssetPath)
  assert.equal(basename(replaced.mainAssetPath), 'new-main.png')

  const previous = replaced.assets.find((a) => a.path === orig)
  assert.ok(previous)
  assert.equal(previous.role, 'reference')

  const reread = store.read(rec.id)
  assert.equal(reread.assets.filter((a) => a.role === 'main').length, 1)
  assert.equal(reread.assets.find((a) => a.role === 'main')?.path, reread.mainAssetPath)
  assert.equal(reread.assets.find((a) => a.path === orig)?.role, 'reference')
})

test('duplicate basename gets unique dest and does not overwrite', (t) => {
  const { store, tmp } = withStore(t)
  const dirA = join(tmp, 'a')
  const dirB = join(tmp, 'b')
  mkdirSync(dirA)
  mkdirSync(dirB)
  const bytesA = Buffer.from('asset-a')
  const bytesB = Buffer.from('asset-b')
  const srcA = join(dirA, 'foo.png')
  const srcB = join(dirB, 'foo.png')
  writeFileSync(srcA, bytesA)
  writeFileSync(srcB, bytesB)

  const rec = store.create({ imagePaths: [srcA, srcB] })
  const paths = rec.assets.map((a) => a.path)
  assert.equal(new Set(paths).size, 2, 'assets[] paths are distinct')
  assert.equal(basename(paths[0]!), 'foo.png')
  assert.equal(basename(paths[1]!), 'foo-1.png')
  assert.ok(existsSync(paths[0]!))
  assert.ok(existsSync(paths[1]!))
  assert.ok(readFileSync(paths[0]!).equals(bytesA), 'first dest not overwritten')
  assert.ok(readFileSync(paths[1]!).equals(bytesB))
  assert.equal(basename(rec.mainAssetPath), 'foo.png')

  const dirC = join(tmp, 'c')
  mkdirSync(dirC)
  const bytesC = Buffer.from('asset-c')
  const srcC = join(dirC, 'foo.png')
  writeFileSync(srcC, bytesC)
  const added = store.addAsset(rec.id, srcC, 'angle')
  const addedPaths = added.assets.map((a) => a.path)
  assert.equal(new Set(addedPaths).size, 3)
  assert.equal(basename(added.assets[2]!.path), 'foo-2.png')
  for (const p of addedPaths) assert.ok(existsSync(p))
  assert.ok(readFileSync(paths[0]!).equals(bytesA), 'main dest still intact')
  assert.ok(readFileSync(added.assets[2]!.path).equals(bytesC))
})

test('traversal of dest throws', (t) => {
  const { store } = withStore(t)
  assert.throws(() => store.projectDir('../../outside'), /path escapes project root/)
  assert.throws(() => store.read('../../outside'))
})

test('missing project throws', (t) => {
  const { store, png } = withStore(t)
  assert.throws(() => store.read('mxp_missing'))
  assert.throws(() => store.addAsset('mxp_missing', png('x.png'), 'angle'))
  assert.throws(() => store.write('mxp_missing', { name: 'x' }))
})

test('11th asset throws; create requires 1–10 existing files', (t) => {
  const { store, png } = withStore(t)
  assert.throws(() => store.create({ imagePaths: [] }))
  const ten = Array.from({ length: 10 }, (_, i) => png(`n${i}.png`))
  store.create({ imagePaths: ten })
  assert.throws(() => store.create({ imagePaths: [...ten, png('extra.png')] }))

  const rec = store.create({ imagePaths: [png('only.png')] })
  for (let i = 0; i < 9; i++) store.addAsset(rec.id, png(`more${i}.png`), 'angle')
  assert.equal(store.read(rec.id).assets.length, 10)
  assert.throws(() => store.addAsset(rec.id, png('overflow.png'), 'angle'))
})

test('write merges patch and enforces status transitions', (t) => {
  const { store, png } = withStore(t)
  const rec = store.create({ imagePaths: [png('a.png')], name: 'untitled' })
  const renamed = store.write(rec.id, { name: 'widget' })
  assert.equal(renamed.name, 'widget')
  assert.equal(renamed.status, 'created')

  const analyzing = store.write(rec.id, { status: 'analyzing' })
  assert.equal(analyzing.status, 'analyzing')
  assert.throws(() => store.write(rec.id, { status: 'planned' }))
})
