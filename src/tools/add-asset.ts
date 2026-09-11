import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AssetRole, ProjectStore } from '../service/project-store.ts'
import { assertInside } from '../util/paths.ts'
import { redactSecrets } from '../util/redact.ts'

const ROLES = ['main', 'angle', 'detail', 'reference'] as const

export function addAssetTool(opts: {
  store: ProjectStore
  storeRoot: string
}) {
  return defineTool({
    name: 'mxpage_add_asset',
    description:
      'Add a product or reference image to an existing mxpage project. Pass image_path. Replacing the main image requires role=main. P1 does not read attachment_id.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Existing mxpage project id' },
      image_path: { type: 'string', description: 'Workspace-relative or absolute image path to copy' },
      attachment_id: { type: 'string', description: 'Unused in P1; pass image_path instead' },
      role: {
        type: 'string',
        enum: ROLES,
        required: true,
        description: 'Asset role. Use main only when replacing the anchoring product photo.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args): Promise<Record<string, string | number | boolean>> => {
      if (!args.image_path) {
        if (args.attachment_id) {
          return { ok: false, error: '请提供 image_path（P1 暂不从附件读取）' }
        }
        return { ok: false, error: redactSecrets('请提供 image_path') }
      }
      const abs = assertInside(opts.storeRoot, args.image_path)
      const record = opts.store.addAsset(args.project_id, abs, args.role as AssetRole)
      return {
        ok: true,
        projectId: record.id,
        assetCount: record.assets.length,
        mainAssetPath: record.mainAssetPath,
      }
    },
  })
}
