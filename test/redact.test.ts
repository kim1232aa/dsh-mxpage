import assert from 'node:assert/strict'
import test from 'node:test'
import { redactSecrets } from '../src/util/redact.ts'

test('redacts sk- and Bearer', () => {
  assert.equal(redactSecrets('key sk-abc123 Bearer tok'), 'key [REDACTED] Bearer [REDACTED]')
})

test('redacts multiple secrets globally', () => {
  assert.equal(
    redactSecrets('sk-aaa Bearer tok1 sk-bbb Bearer tok2'),
    '[REDACTED] Bearer [REDACTED] [REDACTED] Bearer [REDACTED]',
  )
})
