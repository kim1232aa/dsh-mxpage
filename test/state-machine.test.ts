import assert from 'node:assert/strict'
import test from 'node:test'
import { assertTransition, type STATUS } from '../src/service/state-machine.ts'

test('refuses plan before analyze', () => {
  assert.throws(() => assertTransition('created', 'planning'))
})
test('allows created → analyzing → analyzed → planning → planned', () => {
  let s = 'created' as STATUS
  s = assertTransition(s, 'analyzing')
  s = assertTransition(s, 'analyzed')
  s = assertTransition(s, 'planning')
  s = assertTransition(s, 'planned')
  assert.equal(s, 'planned')
})

const LEGAL: Array<[STATUS, STATUS]> = [
  ['created', 'analyzing'],
  ['created', 'failed'],
  ['analyzing', 'analyzed'],
  ['analyzing', 'failed'],
  ['analyzed', 'planning'],
  ['analyzed', 'failed'],
  ['planning', 'planned'],
  ['planning', 'failed'],
  ['planned', 'generating'],
  ['planned', 'editing'],
  ['planned', 'failed'],
  ['generating', 'generated'],
  ['generating', 'failed'],
  ['generated', 'editing'],
  ['generated', 'generating'],
  ['generated', 'failed'],
  ['editing', 'generated'],
  ['editing', 'failed'],
  ['failed', 'analyzing'],
  ['failed', 'planning'],
  ['failed', 'generating'],
  ['failed', 'editing'],
]

test('allows every legal transition in the closed set', () => {
  for (const [from, to] of LEGAL) {
    assert.equal(assertTransition(from, to), to)
  }
})

test('refuses illegal jumps', () => {
  assert.throws(() => assertTransition('generated', 'planned'))
  assert.throws(() => assertTransition('failed', 'created'))
  assert.throws(() => assertTransition('editing', 'analyzing'))
  assert.throws(() => assertTransition('created', 'created'))
})
