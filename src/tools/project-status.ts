import { defineTool } from '@deepseek-ai/dsh-tools'
import { listOutputSections } from '../pipeline/generate.ts'
import type { ProjectStore } from '../service/project-store.ts'

export function projectStatusTool(opts: { store: ProjectStore }) {
  return defineTool({
    name: 'mxpage_project_status',
    description:
      'Read-only mxpage project status. Safe to call at status=created, before analyze. Returns assets and generated sections (key, outputPath, versionId).',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Existing mxpage project id' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => {
      const record = opts.store.read(args.project_id)
      return {
        ok: true,
        status: record.status,
        language: record.language,
        aspectRatio: record.aspectRatio,
        mainAssetPath: record.mainAssetPath,
        assets: record.assets,
        sections: listOutputSections(record.workspaceDir),
      }
    },
  })
}
