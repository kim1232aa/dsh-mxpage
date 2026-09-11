import { defineTool } from '@deepseek-ai/dsh-tools'
import { analyzeProduct } from '../pipeline/analyze.ts'
import type { CompleteJson } from '../provider/vision-text.ts'
import type { ProjectStore } from '../service/project-store.ts'

export function analyzeProductTool(opts: {
  store: ProjectStore
  completeJson?: CompleteJson
}) {
  return defineTool({
    name: 'mxpage_analyze_product',
    description:
      'Analyze product photos into structured selling-point JSON. Writes analysis.json. Requires vision (ctx.llm with image input, or Config textBaseUrl + textModel). Transitions created|failed → analyzing → analyzed.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Existing mxpage project id' },
      model: { type: 'string', description: 'Optional text/vision model override' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 120_000,
    execute: async (args, exec) => {
      return analyzeProduct(
        { store: opts.store, completeJson: opts.completeJson },
        { projectId: args.project_id, model: args.model },
        exec.signal,
      )
    },
  })
}
