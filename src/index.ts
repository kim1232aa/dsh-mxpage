import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer.register).
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: merges `mxpage_page` into JobKindMap and declares ctx.jobs.
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'

import { Config, type Config as MxpageConfig } from './config.ts'
import { createMxpageRuntime } from './host/index.ts'
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

  const runtime = createMxpageRuntime(config, {
    jobs,
    // Jobs are fenced by the owning agent's session id; the live agent is read
    // at call time because it differs per turn.
    resolveOwner: () => {
      try {
        return ctx.get('agent') ?? undefined
      } catch {
        return undefined
      }
    },
  })

  // Model-facing surface. Absent services mean no tools, not a failed boot.
  ctx.inject(['tools', 'attachments'], (tctx) => {
    tctx.effect(() => {
      const disposers = registerMxpageTools(tctx as never, config, runtime)
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
        runtime,
        config,
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
