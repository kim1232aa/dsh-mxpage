import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AssetRole, ProjectStore } from '../service/project-store.ts'
import { materializeAttachment, type AttachmentReader } from '../util/attachments.ts'
import { assertInside } from '../util/paths.ts'
import { redactSecrets } from '../util/redact.ts'

const ROLES = ['main', 'angle', 'detail', 'reference'] as const

export function addAssetTool(opts: {
  store: ProjectStore
  storeRoot: string
  attachments?: AttachmentReader
}) {
  return defineTool({
    name: 'mxpage_add_asset',
    description:
      'Add a product or reference image to an existing mxpage project. Pass image_path or attachment_id. Replacing the main image requires role=main.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Existing mxpage project id' },
      image_path: { type: 'string', description: 'Workspace-relative or absolute image path to copy' },
      attachment_id: { type: 'string', description: 'Chat image attachment id; copied into the project store' },
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
    execute: async (args, exec): Promise<Record<string, string | number | boolean>> => {
      let abs: string | undefined
      try {
        if (args.image_path) {
          abs = assertInside(opts.storeRoot, args.image_path)
        } else if (args.attachment_id) {
          abs = await materializeAttachment(opts.storeRoot, args.attachment_id, opts.attachments, exec.signal)
        }
      } catch (err) {
        return { ok: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) }
      }
      if (!abs) return { ok: false, error: redactSecrets('请提供 image_path 或 attachment_id') }
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
