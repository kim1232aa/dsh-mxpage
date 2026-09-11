import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.ts'
import type { AspectRatio, ContentLanguage, ProjectStore } from '../service/project-store.ts'
import { assertInside } from '../util/paths.ts'

const LANGUAGES = ['zh-CN', 'en', 'ja', 'ko'] as const
const ASPECT_RATIOS = ['1:1', '3:4', '9:16'] as const

export function createProjectTool(opts: {
  store: ProjectStore
  storeRoot: string
  config: Config
}) {
  return defineTool({
    name: 'mxpage_create_project',
    description:
      'Create an mxpage project and copy product photos into assets/ (does not move sources). Call this before generate_section. image_paths are workspace-relative or absolute, 1–10 files.',
    parameters: {
      name: { type: 'string', description: 'Project display name; default untitled' },
      image_paths: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Product image paths (1–10). Copied into the project; sources are left in place.',
      },
      main_image_path: { type: 'string', description: 'Main product image; default first image_paths entry' },
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
    execute: async (args) => {
      const imagePaths = args.image_paths.map((path) => assertInside(opts.storeRoot, path))
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
