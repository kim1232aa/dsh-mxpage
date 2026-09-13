import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer.register).
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: merges `mxpage_page` into JobKindMap and declares ctx.jobs.
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
// Type-only: pulls the settings Context merge (ctx.settings.installSection).
import type {} from '@deepseek-ai/dsh-settings'

import { Config, type Config as MxpageConfig } from './config.ts'
import { createMxpageRuntime, type MxpageRuntime } from './host/index.ts'
import { makeMxpageRoutes, ROUTES } from './host/routes.ts'
import { registerMxpageTools } from './tools/register.ts'

export const name = 'mxpage'

/**
 * **Empty on purpose.**
 *
 * A fiber-level `inject` gates the plugin's own activation. Listing a service a
 * profile does not provide leaves the plugin `pending` forever, and the host
 * reports `plugin tree failed to load: dsh: 1 entry did not activate` and
 * refuses to boot. Verified the hard way: `inject = ['webServer']` broke the
 * `headless` profile outright.
 *
 * So the plugin activates everywhere and acquires each surface through
 * `ctx.inject([...], cb)`, which creates a *child* fiber that waits without
 * blocking the parent. A profile without `webServer` gets no panel API and one
 * without `tools`/`attachments` gets no tools — never a failed boot.
 *
 * `jobs` is read through the optional `ctx.get('jobs')` accessor rather than an
 * injection, because a missing registry must degrade to the plugin's own queue.
 * `ctx.get(name)` is non-strict by default and resolves to `undefined` instead
 * of throwing when the service is absent.
 */
export const inject: string[] = []

export { Config }

/** Settings namespace this plugin owns, mirroring dsh-imagegen's convention. */
export const SETTINGS_NAMESPACE = 'mxpage'

function imageUrlFor(relPath: string): string {
  return `${ROUTES.image}?path=${encodeURIComponent(relPath)}`
}

export function apply(ctx: Context, config: MxpageConfig): void {
  // Optional: the host job registry. Present in the official profiles; absent
  // in stripped ones, where the runtime falls back to its own queue.
  let jobs: JobRegistry | undefined
  try {
    jobs = ctx.get('jobs') as JobRegistry | undefined
  } catch {
    jobs = undefined
  }

  // Mutable current config, kept in sync with the settings service below.
  // Everything downstream (tools, routes) reads through `resolveConfig()`
  // rather than closing over the `config` parameter, so a settings-panel edit
  // takes effect immediately without a plugin reload.
  let current = config
  const resolveConfig = () => current

  let runtime: MxpageRuntime = createMxpageRuntime(current, {
    jobs,
    resolveOwner: () => {
      try {
        return ctx.get('agent') ?? undefined
      } catch {
        return undefined
      }
    },
  })

  /**
   * Rebuilds the runtime after a settings change. Channels only affect the
   * ProviderResolver, but `workspaceDir` and the default counts are baked into
   * the repository/asset-store closures at construction time, so the simplest
   * correct fix is to recreate the whole runtime rather than track which
   * field actually changed.
   */
  function rebuildRuntime(): void {
    runtime = createMxpageRuntime(current, {
      jobs,
      resolveOwner: () => {
        try {
          return ctx.get('agent') ?? undefined
        } catch {
          return undefined
        }
      },
    })
  }

  // Model-facing surface. Absent services mean no tools, not a failed boot.
  // Registered once here (fires immediately, working off whatever `config` /
  // `runtime` are current at that moment) and re-run by the settings
  // `onChange` hook below whenever the user edits the namespace, so every
  // tool closure always captures the live config/runtime.
  let toolDisposers: Array<(() => void) | undefined> = []
  function reRegisterTools(): void {
    for (const dispose of toolDisposers) {
      try {
        dispose?.()
      } catch {
        // never let teardown break the plugin host
      }
    }
    toolDisposers = []
    ctx.inject(['tools', 'attachments'], (tctx) => {
      tctx.effect(() => {
        const disposers = registerMxpageTools(tctx as never, resolveConfig(), runtime)
        toolDisposers = disposers
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
              // never let teardown break the plugin host
            }
          }
        }
      })
    })
  }
  reRegisterTools()

  // Human-facing surface: registers the `mxpage` namespace in the settings
  // service so 设置 → 插件 → MxPage renders a real form (channels, baseUrl,
  // apiKey, models…) instead of only the static `cordis.patch.yml` default.
  // Mirrors the mechanism `@dickpy/dsh-imagegen` uses (installSection).
  // A profile without `settings` (e.g. a minimal headless one) simply never
  // gets this child fiber — tools still work off the patch-file default
  // registered immediately above.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => {
      let initialized = false
      sctx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
        setSource: (source) => {
          current = source()
        },
        onChange: () => {
          if (!initialized) {
            // installSection's first setSource/onChange pair fires
            // synchronously during registration, before `current` could have
            // actually changed from the `config` passed to `apply` — skip the
            // redundant rebuild+re-register it would otherwise trigger.
            initialized = true
            return
          }
          rebuildRuntime()
          reRegisterTools()
        },
      })
      return () => {}
    })
  })

  // Human-facing surface: the browser panel's data API. Loopback-fenced inside
  // the handlers, so a remote browser gets an explanatory 403 rather than data.
  // Only web-ish profiles provide a webserver; a headless profile simply skips
  // this child fiber.
  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => {
      const webServer = wctx.get('webServer') as
        | { register: (route: unknown) => () => void }
        | undefined
      if (!webServer?.register) return () => {}
      const disposers = makeMxpageRoutes({
        runtime: new Proxy({} as MxpageRuntime, {
          get: (_target, prop) => (runtime as never)[prop],
        }),
        config: new Proxy({} as MxpageConfig, {
          get: (_target, prop) => (resolveConfig() as never)[prop],
        }),
        imageUrl: imageUrlFor,
      }).map((route) => webServer.register(route))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // ignore
          }
        }
      }
    })
  })
}
