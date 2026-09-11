import { defineTool } from '@deepseek-ai/dsh-tools'
import { refinePrompt } from '../pipeline/visual-prompt.ts'
import type { VpaMode } from '../prompts/visual-prompt-agent.ts'
import type { CompleteJson } from '../provider/vision-text.ts'
import type { ProjectStore } from '../service/project-store.ts'

const MODES = ['ecommerce_section', 'xiaohongshu_page', 'image_edit'] as const

export function refinePromptTool(opts: {
  store: ProjectStore
  completeJson?: CompleteJson
}) {
  return defineTool({
    name: 'mxpage_refine_prompt',
    description:
      'Run Visual Prompt Agent for one section. Writes prompts/<sectionKey>.json with finalPrompt, negativePrompt, qualityChecklist. Needs analysis (plan optional). mode default ecommerce_section.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Existing mxpage project id' },
      section_key: { type: 'string', required: true, description: 'e.g. hero_01' },
      mode: { type: 'string', enum: MODES, description: 'VPA mode; default ecommerce_section' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => {
      return refinePrompt(
        { store: opts.store, completeJson: opts.completeJson },
        {
          projectId: args.project_id,
          sectionKey: args.section_key,
          mode: args.mode as VpaMode | undefined,
        },
        exec.signal,
      )
    },
  })
}
