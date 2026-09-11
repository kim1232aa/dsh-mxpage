import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package.json declares dsh.bundle.patch', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-mxpage')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.peerDependencies['@deepseek-ai/cordis'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-llm'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-tools'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/schemastery'])
})

test('plugin exports name + apply, not default function', async () => {
  const mod = await import(join(root, 'src/index.ts'))
  assert.equal(mod.name, 'mxpage')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.default, undefined)
  assert.ok(mod.Config)
  assert.deepEqual(mod.inject, ['tools', 'attachments', 'jobs'])
})
