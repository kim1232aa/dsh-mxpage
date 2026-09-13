/**
 * Panel view render coverage.
 *
 * Renders every panel view once through the SSR harness (lib/ui-test.mjs,
 * produced by `npm run build`). The browser bundle is where a view-level
 * crash would white-screen the panel — a红线 — so each view must render
 * without throwing and must produce non-trivial markup.
 *
 * Skips when the harness artifact is missing (same convention as
 * smoke.test.ts / client-bundle.test.ts): run `npm run build` first.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const harnessPath = join(root, 'lib', 'ui-test.js')

test('every panel view SSR-renders without crashing', async (t) => {
  if (!existsSync(harnessPath)) {
    t.skip('lib/ui-test.js missing — run `npm run build`')
    return
  }
  const { renderAllViews } = (await import(pathToFileURL(harnessPath).href)) as {
    renderAllViews: () => Record<string, string>
  }
  const rendered = renderAllViews()
  const expected = [
    'analysis',
    'planner',
    'editor',
    'export',
    'xiaohongshu',
    'batch',
    'monitor',
    'channels',
  ]
  for (const name of expected) {
    const html = rendered[name]
    assert.ok(typeof html === 'string' && html.length > 200, `${name} view rendered suspiciously little`)
  }
  // spot-check view-specific markers so an empty-shell regression fails loudly
  assert.match(rendered.analysis, /商品素材/)
  assert.match(rendered.analysis, /分析结果/)
  assert.match(rendered.export, /一键导出/)
  assert.match(rendered.export, /模型快照/)
  assert.match(rendered.batch, /批量 SKU 建项/)
  assert.match(rendered.monitor, /API 用量与任务/)
  assert.match(rendered.xiaohongshu, /小红书图文/)
  assert.match(rendered.planner, /整页翻译/)
})
