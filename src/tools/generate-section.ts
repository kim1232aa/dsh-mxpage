import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.ts'
import { generateSection } from '../pipeline/generate.ts'
import { imagesClientFromEnv, type ImageSize, type ImagesClient } from '../provider/openai-images.ts'
import type { CompleteJson } from '../provider/vision-text.ts'
import type { ProjectStore } from '../service/project-store.ts'

const SIZES = ['1024x1024', '1024x1536'] as const

const MISSING_KEY = '未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）'

export function generateSectionTool(opts: {
  store: ProjectStore
  storeRoot: string
  config: Config
  saveImage: (input: {
    data: Uint8Array
    mediaType: string
    name?: string
  }) => Promise<{ attachmentId: string }>
  images?: ImagesClient
  completeJson?: CompleteJson
}) {
  return defineTool({
    name: 'mxpage_generate_section',
    description:
      'Generate one page section image (e.g. hero_01). Pass prompt_override in P1, or refine_prompt first so prompts/<sectionKey>.json exists. Writes output/<sectionKey>.png and returns attachmentId. Default size 1024x1024; default references are the main asset plus the first hero output.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Existing mxpage project id' },
      section_key: { type: 'string', required: true, description: 'e.g. hero_01' },
      prompt_override: { type: 'string', description: 'skip VPA' },
      reference_paths: { type: 'array', items: { type: 'string' }, description: 'Extra reference images; default main asset + first hero output' },
      size: { type: 'string', enum: SIZES, description: 'Output size; default 1024x1024' },
      model: { type: 'string', description: 'Image model override' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    execute: async (args, exec): Promise<Record<string, string | number | boolean>> => {
      const images = resolveImages(opts.config, opts.images)
      if (images === undefined) return { ok: false, error: MISSING_KEY }
      return generateSection(
        {
          store: opts.store,
          storeRoot: opts.storeRoot,
          config: opts.config,
          images,
          saveImage: opts.saveImage,
          completeJson: opts.completeJson,
        },
        {
          projectId: args.project_id,
          sectionKey: args.section_key,
          promptOverride: args.prompt_override,
          referencePaths: args.reference_paths,
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
