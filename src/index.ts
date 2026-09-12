import type { Context } from '@deepseek-ai/cordis'

import { Config, type Config as MxpageConfig } from './config.ts'
import { createMxpageRuntime } from './host/index.ts'
import { registerMxpageTools } from './tools/register.ts'

export const name = 'mxpage'

/**
 * Host services this plugin needs. Verified against a working plugin
 * (`@dickpy/dsh-imagegen`, which does `ctx.inject(['tools','attachments','commands'], …)`):
 * `tools` and `attachments` are real service names.
 *
 * `jobs` is deliberately absent — `@deepseek-ai/dsh-jobs` is not a real package.
 * Background work is owned by the plugin's own queued TaskRunner, exactly as
 * `dsh-imagegen` owns its in-process `GenerationTaskQueue`.
 */
export const inject = ['tools', 'attachments']

export { Config }

export function apply(ctx: Context, config: MxpageConfig): void {
  const runtime = createMxpageRuntime(config)

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
}
