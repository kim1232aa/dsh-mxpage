/**
 * Smoke test against the BUILT bundle (`lib/index.js`), not the sources.
 *
 * This is the closest we can get to "does the plugin actually load in DSH"
 * without restarting the running host: it runs the real `apply()` with a mock
 * Cordis context and asserts every tool registers. It also exercises
 * `defineTool`'s spec validation, so a malformed parameter schema fails here.
 *
 * Requires `npm run build` first.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, 'lib', 'index.js')

interface RegisteredTool {
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  execute?: unknown
}

/** Minimal stand-in for the Cordis context a DSH host hands to `apply`. */
function createMockContext() {
  const registered: RegisteredTool[] = []
  const routes: Array<{ kind?: string; path?: string; handler?: unknown }> = []
  const injected: string[][] = []
  let effectRan = false

  const ctx = {
    inject(names: string[], callback: (ctx: unknown) => void) {
      injected.push(names)
      callback(ctx)
    },
    effect(callback: () => (() => void) | void) {
      effectRan = true
      const disposer = callback()
      return () => disposer?.()
    },
    tools: {
      register(tool: unknown) {
        registered.push(tool as RegisteredTool)
        return () => {}
      },
    },
    attachments: {
      async saveImage() {
        return { attachmentId: 'att_test', mediaType: 'image/png', bytes: 3 }
      },
      async readImage() {
        return { data: new Uint8Array([1, 2, 3]) }
      },
      imageHostPath() {
        return undefined
      },
    },
    webServer: {
      register(route: unknown) {
        routes.push(route as { path?: string })
        return () => {}
      },
    },
    get(name: string) {
      return name === 'webServer' ? ctx.webServer : undefined
    },
  }

  return { ctx, registered, routes, injected, effectRan: () => effectRan }
}

test('built bundle applies and registers the full mxpage_* surface', async (t) => {
  if (!existsSync(bundlePath)) {
    t.skip('lib/index.js missing — run `npm run build`')
    return
  }

  const mod = await import(pathToFileURL(bundlePath).href)
  assert.equal(mod.name, 'mxpage')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.default, undefined)
  assert.ok(mod.Config, 'Config schema must be exported')

  const store = mkdtempSync(join(tmpdir(), 'mxpage-smoke-'))
  try {
    const mock = createMockContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.apply(mock.ctx as never, {
      channels: [],
      workspaceDir: store,
      defaultLanguage: 'zh-CN',
      defaultHeroCount: 3,
      defaultDetailCount: 6,
      defaultDetailAspectRatio: '3:4',
      defaultPlatform: 'general_ecommerce',
      defaultStyle: 'generic_clean',
      analyzeTimeoutMs: 180_000,
      promptTimeoutMs: 60_000,
      imageTimeoutMs: 120_000,
      maxReferenceImages: 4,
      maxAnalysisImages: 10,
      maxParallelSections: 2,
      maxParallelProjects: 1,
      rotateChannelOnQuotaExhausted: true,
      allowSvgFallback: false,
    })

    assert.ok(mock.effectRan(), 'apply must register through ctx.effect')
    // Both surfaces are acquired through child fibers, so the plugin itself
    // never blocks on a service the profile may not provide.
    assert.deepEqual(mock.injected, [['tools', 'attachments'], ['webServer']])

    const names = mock.registered.map((tool) => tool.name).sort()
    assert.deepEqual(names, [
      'mxpage_add_asset',
      'mxpage_analyze_product',
      'mxpage_channels',
      'mxpage_create_project',
      'mxpage_edit_section',
      'mxpage_export_page',
      'mxpage_generate_page',
      'mxpage_generate_section',
      'mxpage_job_cancel',
      'mxpage_job_status',
      'mxpage_plan_page',
      'mxpage_project_status',
      'mxpage_xiaohongshu_edit',
      'mxpage_xiaohongshu_generate',
      'mxpage_xiaohongshu_plan',
    ])

    for (const tool of mock.registered) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real description`)
      assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute`)
      assert.ok(tool.parameters, `${tool.name} needs parameters`)
    }

    // The workspace root must have been created under the configured dir.
    assert.ok(existsSync(store), 'workspace dir should exist')

    // The browser panel's data API must be mounted on the host webServer.
    const paths = mock.routes.map((route) => route.path).filter(Boolean) as string[]
    assert.ok(paths.length >= 20, `expected the panel API routes, found ${paths.length}`)
    for (const expected of [
      '/api/dsh-mxpage/projects',
      '/api/dsh-mxpage/projects/create',
      '/api/dsh-mxpage/project',
      '/api/dsh-mxpage/analyze',
      '/api/dsh-mxpage/plan',
      '/api/dsh-mxpage/generate',
      '/api/dsh-mxpage/edit',
      '/api/dsh-mxpage/generate-page',
      '/api/dsh-mxpage/job',
      '/api/dsh-mxpage/versions',
      '/api/dsh-mxpage/export',
      '/api/dsh-mxpage/image',
      '/api/dsh-mxpage/channels',
      '/api/dsh-mxpage/xiaohongshu/plan',
      '/api/dsh-mxpage/xiaohongshu/generate',
      '/api/dsh-mxpage/xiaohongshu/edit',
    ]) {
      assert.ok(paths.includes(expected), `missing panel route ${expected}`)
    }
    for (const route of mock.routes) {
      assert.equal(route.kind, 'exact', `${route.path} must be an exact route`)
      assert.equal(typeof route.handler, 'function', `${route.path} must have a handler`)
    }
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})

test('an unconfigured channel surfaces an actionable error, not a crash', async (t) => {
  if (!existsSync(bundlePath)) {
    t.skip('lib/index.js missing — run `npm run build`')
    return
  }
  const mod = await import(pathToFileURL(bundlePath).href)
  const store = mkdtempSync(join(tmpdir(), 'mxpage-smoke2-'))
  try {
    const mock = createMockContext()
    mod.apply(mock.ctx as never, {
      channels: [],
      workspaceDir: store,
      defaultLanguage: 'zh-CN',
      defaultHeroCount: 3,
      defaultDetailCount: 6,
      defaultDetailAspectRatio: '3:4',
      defaultPlatform: 'general_ecommerce',
      defaultStyle: 'generic_clean',
      analyzeTimeoutMs: 180_000,
      promptTimeoutMs: 60_000,
      imageTimeoutMs: 120_000,
      maxReferenceImages: 4,
      maxAnalysisImages: 10,
      maxParallelSections: 2,
      maxParallelProjects: 1,
      rotateChannelOnQuotaExhausted: true,
      allowSvgFallback: false,
    })

    const channels = mock.registered.find((tool) => tool.name === 'mxpage_channels')
    assert.ok(channels?.execute)

    // Dispatch the tool the way the runtime would.
    const runner = channels.execute as (
      args: unknown,
      exec: { signal: AbortSignal },
    ) => Promise<Record<string, unknown>>
    const result = await runner({}, { signal: new AbortController().signal })

    assert.equal(result.ok, false)
    assert.equal(result.error, 'MXPAGE_HTTP_401')
    assert.match(String(result.message), /渠道/, 'the error must tell the user what to configure')
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})
