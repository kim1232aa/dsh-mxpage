import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as MxpageConfig } from './config.ts'
import { registerMxpageTools } from './tools/register.ts'

export const name = 'mxpage'
export const inject = ['tools', 'attachments', 'jobs']
export { Config }

export function apply(ctx: Context, config: MxpageConfig) {
  // Cordis throws on `ctx.llm` unless `llm` is in inject. Use get() so web
  // profile vision is optional and the plugin still boots.
  registerMxpageTools(ctx as never, config, {
    llm: ctx.get('llm'),
  })
}
