import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { assertInside } from '../src/util/paths.ts'

// NOTE: the v0.1 version of this test hard-coded POSIX paths and therefore
// failed on Windows. `assertInside` returns `path.resolve` output, so the
// expectations are built with `resolve` too.
const root = resolve('/tmp/proj')

test('rejects absolute path traversal', () => {
  assert.throws(() => assertInside(root, resolve(root, '../outside.png')))
})

test('rejects relative path traversal', () => {
  assert.throws(() => assertInside(root, '../outside.png'))
})

test('accepts a nested absolute asset path', () => {
  const target = resolve(root, 'assets/main.jpg')
  assert.equal(assertInside(root, target), target)
})

test('resolves a relative target against the root', () => {
  assert.equal(assertInside(root, 'assets/main.jpg'), resolve(root, 'assets/main.jpg'))
})
