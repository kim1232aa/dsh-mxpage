import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function readPkg() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
}

test('package.json declares the DSH bundle patch and a lib/ output', () => {
  const pkg = readPkg()
  assert.equal(pkg.name, 'dsh-mxpage')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
})

test('peerDependencies use the real host package names', () => {
  const pkg = readPkg()
  // Verified against an installed, working plugin (@dickpy/dsh-imagegen).
  assert.ok(pkg.peerDependencies['@deepseek-ai/cordis'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-tools'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-attachment'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-llm'])
  // schemastery is a plain dependency, NOT @deepseek-ai/schemastery.
  assert.ok(pkg.dependencies.schemastery)
  assert.equal(pkg.peerDependencies['@deepseek-ai/schemastery'], undefined)
  // @deepseek-ai/dsh-jobs is not a real package; the plugin owns its task queue.
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-jobs'], undefined)
})

test('plugin exports name + apply, not a default function', async () => {
  // Windows requires a file:// URL for a dynamic import of an absolute path.
  const mod = await import(pathToFileURL(join(root, 'src/index.ts')).href)
  assert.equal(mod.name, 'mxpage')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.default, undefined)
  assert.ok(mod.Config)
  // EMPTY on purpose: a fiber-level inject that a profile cannot satisfy leaves
  // the plugin pending forever and the host refuses to boot (verified against
  // the headless profile). Surfaces are acquired per-effect instead.
  assert.deepEqual(mod.inject, [])
})

test('every registered tool is mxpage_* and never shadows dsh-imagegen', () => {
  const source = readFileSync(join(root, 'src/tools/register.ts'), 'utf8')
  const names = [...source.matchAll(/name:\s*'(mxpage_[a-z0-9_]+)'/g)].map((match) => match[1])
  assert.ok(names.length >= 10, `expected >=10 tools, found ${names.length}`)
  assert.equal(new Set(names).size, names.length, 'tool names must be unique')
  for (const forbidden of ['generate_image', 'edit_image', 'image_generate']) {
    assert.ok(!names.includes(forbidden), `must not register ${forbidden}`)
  }
})

/** Strips comments so doc-comment mentions of `process.cwd()` don't trip the scan. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('mxpage-core stays host-agnostic', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!full.endsWith('.ts')) continue
      const code = stripComments(readFileSync(full, 'utf8'))
      const rel = full.slice(root.length + 1)
      if (/from\s+'@deepseek-ai\//.test(code)) offenders.push(`${rel}: imports a DSH package`)
      if (/from\s+'schemastery'/.test(code)) offenders.push(`${rel}: imports schemastery`)
      if (/process\.(cwd|env)/.test(code)) offenders.push(`${rel}: touches process.cwd/env`)
      if (/from\s+'@prisma\//.test(code)) offenders.push(`${rel}: imports Prisma`)
      if (/from\s+'(next|react)/.test(code)) offenders.push(`${rel}: imports a UI framework`)
    }
  }
  walk(join(root, 'src/core'))
  assert.deepEqual(offenders, [])
})
