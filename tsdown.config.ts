import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { defineConfig } from 'tsdown'

// Two bundles, mirroring the DSH plugin convention used by
// `@dickpy/dsh-imagegen` and `dsh-model-detector`:
//   lib/index.js   host half   (tools, tasks, filesystem, upstream APIs) — plain ESM
//   lib/client.js  browser half (panel) — NOT ESM; see below
//
// Everything the host provides is `external` — it is injected by the DSH
// loader at runtime and must never be inlined.
const here = dirname(fileURLToPath(import.meta.url))

const hostExternal = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-host-webserver',
  'schemastery',
]

const clientExternal = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-connection',
  'react',
  'react-dom',
]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    outDir: 'lib',
    clean: true,
    dts: false,
    sourcemap: false,
    external: hostExternal,
  },
  // The DSH web shell does not load client halves as ESM. It expects
  //   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
  // so the browser bundle is emitted as CJS into an intermediate file and then
  // wrapped by scripts/wrap-client.mjs. tsdown fails hard on a missing entry, so
  // the browser half is only declared once it exists.
  ...(existsSync(join(here, 'src/client/index.ts'))
    ? [
        {
          entry: { 'client.raw': 'src/client/index.ts' },
          format: ['cjs' as const],
          platform: 'browser' as const,
          outDir: 'lib',
          clean: false,
          dts: false,
          sourcemap: false,
          external: clientExternal,
        },
      ]
    : []),
  // Test-only SSR harness for the panel views (test/ui-views.test.ts). Emitted
  // next to the bundles so the test can import it; NOT shipped (`files` only
  // lists lib/, but keeping the name distinct makes the intent obvious).
  ...(existsSync(join(here, 'test/ui-entry.tsx'))
    ? [
        {
          entry: { 'ui-test': 'test/ui-entry.tsx' },
          format: ['esm' as const],
          platform: 'node' as const,
          outDir: 'lib',
          clean: false,
          dts: false,
          sourcemap: false,
          external: ['react', 'react-dom', 'react-dom/server'],
        },
      ]
    : []),
])
