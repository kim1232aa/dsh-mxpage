import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { defineConfig } from 'tsdown'

// Two bundles, mirroring the DSH plugin convention used by
// `@dickpy/dsh-imagegen` and `dsh-model-detector`:
//   lib/index.js   host half    (tools, tasks, filesystem, upstream APIs)
//   lib/client.js  browser half (Studio panel)
//
// Everything the host provides is `external` — it is injected by the DSH loader
// at runtime and must never be inlined into the bundle.
const here = dirname(fileURLToPath(import.meta.url))

const hostExternal = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-llm',
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
  'schemastery',
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
  // tsdown fails hard on a missing entry, so the browser half is only declared
  // once it exists.
  ...(existsSync(join(here, 'src/client/index.ts'))
    ? [
        {
          entry: { client: 'src/client/index.ts' },
          format: ['esm' as const],
          platform: 'browser' as const,
          outDir: 'lib',
          clean: false,
          dts: false,
          sourcemap: false,
          external: clientExternal,
        },
      ]
    : []),
])
