/**
 * Wraps the CJS browser bundle in the DSH module-loader envelope.
 *
 * The web shell does not import client halves as ESM. Every shipped client
 * bundle — `@dickpy/dsh-imagegen`, `dsh-model-detector`, `dsh-tongflow`, … —
 * has this shape:
 *
 *   window.__ModuleLoader__.load({
 *     id: '<package name>',
 *     factory: (require) => {
 *       var module = { exports: {} }
 *       var exports = module.exports
 *       Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
 *       …cjs body…
 *       return module.exports
 *     },
 *   })
 *
 * `@dsh-plugin/dsh-loader` supplies `__ModuleLoader__` and the `require`
 * resolver (which maps `react`, `react-dom` and the `@deepseek-ai/dsh-client-*`
 * packages onto the shell's live module table).
 *
 * Usage: node scripts/wrap-client.mjs
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const candidates = [
  join(root, 'lib', 'client.raw.cjs'),
  join(root, 'lib', 'client.raw.js'),
]
const rawPath = candidates.find((candidate) => {
  try {
    readFileSync(candidate)
    return true
  } catch {
    return false
  }
})

if (!rawPath) {
  console.error(`[wrap-client] no intermediate bundle found in ${join(root, 'lib')}`)
  process.exit(1)
}

const body = readFileSync(rawPath, 'utf8')

// The CJS body may already declare `module`/`exports` via rolldown's interop;
// running it inside the factory scope shadows those, which is exactly what the
// other shipped bundles do.
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body
  .split('\n')
  .map((line) => (line.length > 0 ? `\t\t${line}` : line))
  .join('\n')}
\t\treturn module.exports;
\t}
});
`

const outPath = join(root, 'lib', 'client.js')
writeFileSync(outPath, wrapped, 'utf8')
rmSync(rawPath, { force: true })
console.log(`[wrap-client] ${outPath} written (${wrapped.length} bytes) from ${rawPath.split(/[\\/]/).pop()}`)
