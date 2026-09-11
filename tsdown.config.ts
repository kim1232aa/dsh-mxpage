import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  format: ['esm'],
  platform: 'node',
  outDir: '.',
  clean: false,
  dts: false,
  sourcemap: false,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/schemastery',
  ],
})
