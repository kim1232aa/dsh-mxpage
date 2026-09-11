import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as MxpageConfig } from './config.ts'
import { registerMxpageTools } from './tools/register.ts'

export const name = 'mxpage'
export const inject = ['tools', 'attachments', 'jobs']
export { Config }

export function apply(ctx: Context, config: MxpageConfig) {
  registerMxpageTools(ctx as never, config, {
    llm: (ctx as { llm?: unknown }).llm,
  })
}
