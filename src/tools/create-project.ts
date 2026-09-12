import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.ts'
import type { AspectRatio, ContentLanguage, ProjectStore } from '../service/project-store.ts'
import { materializeAttachment, type AttachmentReader } from '../util/attachments.ts'
import { assertInside } from '../util/paths.ts'
import { redactSecrets } from '../util/redact.ts'

const LANGUAGES = ['zh-CN', 'en', 'ja', 'ko'] as const
const ASPECT_RATIOS = ['1:1', '3:4', '9:16'] as const

export function createProjectTool(opts: {
  store: ProjectStore
  storeRoot: string
  config: Config
  attachments?: AttachmentReader
}) {
  return defineTool({
    name: 'mxpage_create_project',
    description:
      'Create an mxpage project and copy product photos into assets/ (does not move sources). Call this before generate_section. Pass image_paths (workspace files inside the mxpage store) and/or attachment_ids from the current chat image. Combined 1–10 images. Default main is the first.',
    parameters: {
      name: { type: 'string', description: 'Project display name; default untitled' },
      image_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Product image paths (workspace-relative or absolute, inside the mxpage store). Combined with attachment_ids, 1–10 files.',
      },
      attachment_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Chat image attachment ids from the current turn. Copied into the project store; 1–10 combined with image_paths.',
      },
      main_image_path: { type: 'string', description: 'Main product image path; default first resolved image' },
      language: {
        type: 'string',
        enum: LANGUAGES,
        description: 'Content language',
      },
      aspect_ratio: {
        type: 'string',
        enum: ASPECT_RATIOS,
        description: 'Default detail aspect ratio',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => {
      const pathArgs = Array.isArray(args.image_paths) ? args.image_paths : []
      const attachmentArgs = Array.isArray(args.attachment_ids) ? args.attachment_ids : []
      const imagePaths = pathArgs.map((path) => assertInside(opts.storeRoot, path))
      try {
        for (const id of attachmentArgs) {
          imagePaths.push(await materializeAttachment(opts.storeRoot, id, opts.attachments, exec.signal))
        }
      } catch (err) {
        return { ok: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) }
      }
      if (imagePaths.length < 1 || imagePaths.length > 10) {
        return { ok: false, error: '请提供 image_paths 或 attachment_ids（1–10 张）' }
      }
      const mainImagePath = args.main_image_path === undefined
        ? undefined
        : assertInside(opts.storeRoot, args.main_image_path)
      const record = opts.store.create({
        name: args.name,
        imagePaths,
        mainImagePath,
        language: (args.language ?? opts.config.defaultLanguage) as ContentLanguage,
        aspectRatio: args.aspect_ratio as AspectRatio | undefined,
      })
      return {
        ok: true,
        projectId: record.id,
        assetCount: record.assets.length,
        mainAssetPath: record.mainAssetPath,
        workspaceDir: record.workspaceDir,
      }
    },
  })
}
