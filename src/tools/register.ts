import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import type { ImagesClient } from '../provider/openai-images.ts'
import { resolveCompleteJson, type CompleteJson, type SaveImageFn } from '../provider/vision-text.ts'
import { createStore } from '../service/project-store.ts'
import { addAssetTool } from './add-asset.ts'
import { analyzeProductTool } from './analyze.ts'
import { createProjectTool } from './create-project.ts'
import { generateSectionTool } from './generate-section.ts'
import { planPageTool } from './plan.ts'
import { projectStatusTool } from './project-status.ts'
import { refinePromptTool } from './refine-prompt.ts'

export interface MxpageToolsHost {
  tools: { register: (tool: object) => unknown }
  attachments: {
    saveImage: (input: {
      data: Uint8Array
      mediaType: string
      name?: string
    }) => Promise<{
      attachmentId: string
      mediaType?: string
      bytes?: number
      width?: number
      height?: number
      name?: string
    }>
  }
  llm?: unknown
}

export interface RegisterMxpageToolsDeps {
  images?: ImagesClient
  completeJson?: CompleteJson
  llm?: unknown
}

export function resolveStoreRoot(config: Config): string {
  if (config.workspaceDir) return config.workspaceDir
  return join(process.env.DSH_HOME ?? homedir(), 'mxpage')
}

function asSaveImage(saveImage: MxpageToolsHost['attachments']['saveImage']): SaveImageFn {
  return async (input) => {
    const ref = await saveImage(input)
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType ?? input.mediaType,
      bytes: ref.bytes ?? input.data.byteLength,
      width: ref.width ?? 0,
      height: ref.height ?? 0,
      name: ref.name ?? input.name,
    }
  }
}

export function registerMxpageTools(
  ctx: MxpageToolsHost,
  config: Config,
  deps?: RegisterMxpageToolsDeps,
): void {
  const storeRoot = resolveStoreRoot(config)
  const store = createStore(storeRoot)
  const saveImage = asSaveImage((input) => ctx.attachments.saveImage(input))
  const completeJson = resolveCompleteJson({
    completeJson: deps?.completeJson,
    llm: deps?.llm ?? ctx.llm,
    config,
    saveImage,
  })
  ctx.tools.register(createProjectTool({ store, storeRoot, config }))
  ctx.tools.register(addAssetTool({ store, storeRoot }))
  ctx.tools.register(projectStatusTool({ store }))
  ctx.tools.register(analyzeProductTool({ store, completeJson }))
  ctx.tools.register(planPageTool({ store, config, completeJson }))
  ctx.tools.register(refinePromptTool({ store, completeJson }))
  ctx.tools.register(generateSectionTool({
    store,
    storeRoot,
    config,
    saveImage: (input) => ctx.attachments.saveImage(input),
    images: deps?.images,
    completeJson,
  }))
}
