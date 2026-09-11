import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as MxpageConfig } from './config.ts'

export const name = 'mxpage'
export const inject = ['tools', 'attachments', 'jobs']
export { Config }

export function apply(_ctx: Context, _config: MxpageConfig) {
  // tools registered in Task 4
}
