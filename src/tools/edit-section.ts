import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.ts'
import { editSection } from '../pipeline/edit.ts'
import type { EditMode, PromptLanguage } from '../prompts/generation.ts'
import { imagesClientFromEnv, type ImageSize, type ImagesClient } from '../provider/openai-images.ts'
import type { ProjectStore } from '../service/project-store.ts'
import { redactSecrets } from '../util/redact.ts'

const SIZES = ['1024x1024', '1024x1536'] as const
const MODES = ['repaint', 'enhance', 'translate'] as const
const LANGUAGES = ['zh-CN', 'en', 'ja', 'ko'] as const
const MISSING_KEY = '未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）'

import { renderJsonAndImages } from './render.ts'

export function editSectionTool(opts: {
  store: ProjectStore
  storeRoot: string
  config: Config
  saveImage: (input: {
    data: Uint8Array
    mediaType: string
    name?: string
  }) => Promise<{ attachmentId: string }>
  images?: ImagesClient
}) {
  return defineTool({
    name: 'mxpage_edit_section',
    description:
      'Edit an existing section image (repaint / enhance / translate). Writes a new versions/<key>/vN.png and updates output/<key>.png; older version files are kept. instruction required for repaint/enhance; target_language required for translate.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Existing mxpage project id' },
      section_key: { type: 'string', required: true, description: 'e.g. hero_01' },
      mode: { type: 'string', enum: MODES, required: true, description: 'repaint, enhance, or translate' },
      instruction: { type: 'string', description: 'Required for repaint and enhance' },
      target_language: { type: 'string', enum: LANGUAGES, description: 'Required for translate' },
      size: { type: 'string', enum: SIZES, description: 'Output size; default 1024x1024' },
      model: { type: 'string', description: 'Image model override' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJsonAndImages,
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const mode = args.mode as EditMode
      if (mode === 'translate' && !args.target_language) {
        return { ok: false, error: 'MXPAGE_MISSING_LANGUAGE' }
      }
      if ((mode === 'repaint' || mode === 'enhance') && !args.instruction?.trim()) {
        return { ok: false, error: redactSecrets('请提供 instruction') }
      }
      const images = resolveImages(opts.config, opts.images)
      if (images === undefined) return { ok: false, error: MISSING_KEY }
      return editSection(
        {
          store: opts.store,
          storeRoot: opts.storeRoot,
          config: opts.config,
          images,
          saveImage: opts.saveImage,
        },
        {
          projectId: args.project_id,
          sectionKey: args.section_key,
          mode,
          instruction: args.instruction,
          targetLanguage: args.target_language as PromptLanguage | undefined,
          size: args.size as ImageSize | undefined,
          model: args.model,
        },
        exec.signal,
      )
    },
  })
}

function resolveImages(config: Config, injected?: ImagesClient): ImagesClient | undefined {
  if (injected) return injected
  return imagesClientFromEnv(config)
}
