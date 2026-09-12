import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer.register).
import type {} from '@deepseek-ai/dsh-host-webserver'

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
 * `jobs` is deliberately absent — `@deepseek-ai/dsh-jobs` is not a real package.
 * Background work is owned by the plugin's own queued TaskRunner, exactly as
 * `dsh-imagegen` owns its in-process `GenerationTaskQueue`.
 */
export const inject = ['webServer']

export { Config }

function imageUrlFor(relPath: string): string {
  return `${ROUTES.image}?path=${encodeURIComponent(relPath)}`
}

export function apply(ctx: Context, config: MxpageConfig): void {
  const runtime = createMxpageRuntime(config)

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
