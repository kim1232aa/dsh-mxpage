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
