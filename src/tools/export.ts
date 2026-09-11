import { defineTool } from '@deepseek-ai/dsh-tools'
import { exportPage, type ExportFormat } from '../pipeline/export.ts'
import type { ProjectStore } from '../service/project-store.ts'

const FORMATS = ['paths', 'zip'] as const

export function exportPageTool(opts: { store: ProjectStore }) {
  return defineTool({
    name: 'mxpage_export_page',
    description:
      'List generated section PNG paths or zip them with analysis.json. format defaults to paths. Zip is written to output/export-<iso>.zip.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Existing mxpage project id' },
      format: {
        type: 'string',
        enum: FORMATS,
        description: 'paths (default) or zip',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => {
      return exportPage(
        { store: opts.store },
        {
          projectId: args.project_id,
          format: args.format as ExportFormat | undefined,
        },
      )
    },
  })
}
