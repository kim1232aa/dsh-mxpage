import assert from 'node:assert/strict'
import test from 'node:test'
import { assertInside } from '../src/util/paths.ts'

test('rejects path traversal', () => {
  assert.throws(() => assertInside('/tmp/proj', '/tmp/proj/../outside.png'))
})
test('accepts nested asset path', () => {
  assert.equal(assertInside('/tmp/proj', '/tmp/proj/assets/main.jpg'), '/tmp/proj/assets/main.jpg')
})

test('resolves relative target against root', () => {
  assert.equal(assertInside('/tmp/proj', 'assets/main.jpg'), '/tmp/proj/assets/main.jpg')
})

test('rejects relative path traversal', () => {
  assert.throws(() => assertInside('/tmp/proj', '../outside.png'))
})
