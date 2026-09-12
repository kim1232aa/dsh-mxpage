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
 * Host services this plugin needs. Verified against a working plugin
 * (`@dickpy/dsh-imagegen`, which does
 * `ctx.inject(['tools','attachments','commands'], …)` and
 * `export const inject = ['webServer','systemPrompt','commands']`):
 * `tools`, `attachments` and `webServer` are real service names.
 *
 * `jobs` is deliberately NOT in the fiber `inject` list even though it exists
 * (`@deepseek-ai/dsh-jobs-local` in dsh-base): a missing job registry must
 * degrade to the plugin's own queue rather than fail the plugin boot, so it is
 * read through the optional `ctx.get('jobs')` accessor instead.
 */
export const inject = ['webServer']

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

  // Model-facing surface.
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
  const webServer = ctx.get('webServer') as
    | { register: (route: unknown) => () => void }
    | undefined
  if (webServer?.register) {
    ctx.effect(() => {
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
  }
}
