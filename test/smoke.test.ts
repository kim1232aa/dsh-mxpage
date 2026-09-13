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
  let settingsHooks: { setSource: (source: () => unknown) => void; onChange: () => void } | undefined

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
    // Mirrors the real `SettingsProvider.installSection`: fires `setSource`
    // then `onChange` once synchronously at registration. `settingsHooks`
    // captures the pair so a test can simulate a later settings-panel edit
    // by calling `simulateSettingsUpdate` below.
    settings: {
      installSection(
        _owner: unknown,
        _ns: string,
        _schema: unknown,
        entry: unknown,
        hooks: { setSource: (source: () => unknown) => void; onChange: () => void },
      ) {
        settingsHooks = hooks
        hooks.setSource(() => entry)
        hooks.onChange()
      },
    },
    get(name: string) {
      if (name === 'webServer') return ctx.webServer
      if (name === 'settings') return ctx.settings
      return undefined
    },
  }

  return {
    ctx,
    registered,
    routes,
    injected,
    effectRan: () => effectRan,
    /** Simulates a settings-panel edit by re-invoking the captured hooks. */
    simulateSettingsUpdate(nextConfig: unknown) {
      if (!settingsHooks) throw new Error('settings.installSection was never called')
      settingsHooks.setSource(() => nextConfig)
      settingsHooks.onChange()
    },
  }
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
    // All three surfaces are acquired through child fibers, so the plugin
    // itself never blocks on a service the profile may not provide.
    assert.deepEqual(mock.injected, [['tools', 'attachments'], ['settings'], ['webServer']])

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

    // -----------------------------------------------------------------
    // INCIDENT REGRESSION: every route's handler used to accept a THIRD
    // `method` parameter that the real host never supplies (the real
    // `WebRoute.handler` signature is `(req, res) => void | Promise<void>`
    // with no third argument). Because the method check compared the
    // incoming request's method against that always-undefined parameter,
    // EVERY route answered "method not allowed" for every request — caught
    // live in a real DSH host, not by any prior test, because this suite
    // only ever checked `typeof handler === 'function'` and never actually
    // invoked one.
    //
    // This block invokes each handler the way the real host does — two
    // arguments, no third — and asserts a route actually answers instead of
    // rejecting its own expected method.
    // -----------------------------------------------------------------
    const getPaths = new Set([
      '/api/dsh-mxpage/project',
      '/api/dsh-mxpage/job',
      '/api/dsh-mxpage/versions',
      '/api/dsh-mxpage/image',
    ])
    for (const route of mock.routes) {
      if (!route.path) continue
      const method = getPaths.has(route.path) ? 'GET' : 'POST'
      const chunks: Buffer[] = []
      const fakeReq = {
        method,
        url: `${route.path}?id=x&sectionId=x`,
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          yield* chunks
        },
      }
      let statusCode = 0
      let body = ''
      const fakeRes = {
        writeHead(status: number) {
          statusCode = status
        },
        end(payload?: string) {
          body = payload ?? ''
        },
      }
      // Exactly the real host's call shape: two arguments, no `method`.
      await (route.handler as (req: unknown, res: unknown) => Promise<void>)(fakeReq, fakeRes)

      assert.notEqual(
        statusCode,
        405,
        `${route.path} rejected its own expected method (${method}) — the envelope/method wiring regressed`,
      )
      let parsed: { ok?: boolean; error?: string } = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        // the /image route serves raw bytes, not JSON — that's fine, it only
        // needs to not be a 405
      }
      if (parsed.error) {
        assert.notEqual(
          parsed.error,
          'method-not-allowed',
          `${route.path} answered method-not-allowed for its own expected method (${method})`,
        )
      }
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

test('editing the settings-panel section takes effect without a plugin reload', async (t) => {
  if (!existsSync(bundlePath)) {
    t.skip('lib/index.js missing — run `npm run build`')
    return
  }
  const mod = await import(pathToFileURL(bundlePath).href)
  const store = mkdtempSync(join(tmpdir(), 'mxpage-smoke3-'))
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

    // Before any settings edit: no channel configured, mxpage_channels fails.
    const before = mock.registered.find((tool) => tool.name === 'mxpage_channels')
    const beforeResult = await (
      before?.execute as (args: unknown, exec: { signal: AbortSignal }) => Promise<Record<string, unknown>>
    )({}, { signal: new AbortController().signal })
    assert.equal(beforeResult.ok, false)

    // Simulate the user filling in 设置 → 插件 → MxPage with a real channel —
    // exactly what `installSection`'s `onChange` fires for on a live edit.
    mock.simulateSettingsUpdate({
      channels: [
        {
          id: 'test-channel',
          label: 'Test channel',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'sk-test',
          models: ['grok-imagine-image-2.0'],
        },
      ],
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

    // Tools were re-registered — a fresh `mxpage_channels` closure must now
    // see the new channel without the plugin having been reloaded.
    const after = mock.registered.filter((tool) => tool.name === 'mxpage_channels').pop()
    assert.ok(after, 'mxpage_channels must still be registered after the edit')
    const afterResult = await (
      after?.execute as (args: unknown, exec: { signal: AbortSignal }) => Promise<Record<string, unknown>>
    )({}, { signal: new AbortController().signal })

    assert.equal(afterResult.ok, true, `expected the new channel to resolve, got ${JSON.stringify(afterResult)}`)
    assert.equal((afterResult.channel as { id?: string })?.id, 'test-channel')

    // Panel routes must also see the live runtime. A prior version captured
    // `runtime.host` at registration, so the /channels handler kept talking
    // to the empty ProviderResolver after the settings edit.
    const channelsRoute = mock.routes.find((route) => route.path === '/api/dsh-mxpage/channels')
    assert.ok(channelsRoute?.handler, 'the panel /channels route must exist')
    let statusCode = 0
    let body = ''
    await (
      channelsRoute.handler as (req: unknown, res: unknown) => Promise<void>
    )(
      {
        method: 'POST',
        url: '/api/dsh-mxpage/channels',
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{}')
        },
      },
      {
        writeHead(status: number) {
          statusCode = status
        },
        end(payload?: string) {
          body = payload ?? ''
        },
      },
    )
    assert.equal(statusCode, 200)
    const parsed = JSON.parse(body) as {
      ok?: boolean
      channel?: { id?: string }
      channels?: Array<{ id?: string }>
    }
    assert.equal(parsed.ok, true, `panel /channels must succeed after the edit, got ${body}`)
    assert.equal(parsed.channel?.id, 'test-channel')
    assert.ok(parsed.channels?.some((channel) => channel.id === 'test-channel'))
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})
