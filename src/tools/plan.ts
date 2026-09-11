import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.ts'
import { planPage } from '../pipeline/plan.ts'
import type { PlanPlatform, PromptLanguage } from '../prompts/planning.ts'
import type { CompleteJson } from '../provider/vision-text.ts'
import type { ProjectStore } from '../service/project-store.ts'

const PLATFORMS = ['ecommerce', 'xiaohongshu'] as const
const LANGUAGES = ['zh-CN', 'en', 'ja', 'ko'] as const

export function planPageTool(opts: {
  store: ProjectStore
  config: Config
  completeJson?: CompleteJson
}) {
  return defineTool({
    name: 'mxpage_plan_page',
    description:
      'Plan hero and detail sections plus a visual style guide. Requires status analyzed (or planned to replan). Writes plan.json and style-guide.json. hero_count 1–5 default 3, detail_count 1–10 default 6.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Existing mxpage project id; must be analyzed or planned' },
      hero_count: { type: 'number', description: 'Hero images, 1–5; default config.defaultHeroCount (3)' },
      detail_count: { type: 'number', description: 'Detail modules, 1–10; default config.defaultDetailCount (6)' },
      platform: { type: 'string', enum: PLATFORMS, description: 'ecommerce or xiaohongshu; default ecommerce' },
      language: { type: 'string', enum: LANGUAGES, description: 'Content language override' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => {
      return planPage(
        { store: opts.store, config: opts.config, completeJson: opts.completeJson },
        {
          projectId: args.project_id,
          heroCount: args.hero_count,
          detailCount: args.detail_count,
          platform: args.platform as PlanPlatform | undefined,
          language: args.language as PromptLanguage | undefined,
        },
        exec.signal,
      )
    },
  })
}
