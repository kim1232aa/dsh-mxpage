import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import type { ImagesClient } from '../provider/openai-images.ts'
import { resolveCompleteJson, type CompleteJson, type SaveImageFn } from '../provider/vision-text.ts'
import { createStore } from '../service/project-store.ts'
import { addAssetTool } from './add-asset.ts'
import { analyzeProductTool } from './analyze.ts'
import { createProjectTool } from './create-project.ts'
import { editSectionTool } from './edit-section.ts'
import { exportPageTool } from './export.ts'
import { generatePageTool } from './generate-page.ts'
import { generateSectionTool } from './generate-section.ts'
import { jobCancelTool, jobStatusTool, type MxpageJobsApi } from './job.ts'
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
  jobs: MxpageJobsApi
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
    llm: deps?.llm,
    config,
    saveImage,
  })
  const toolSaveImage = (input: { data: Uint8Array; mediaType: string; name?: string }) =>
    ctx.attachments.saveImage(input)
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
    saveImage: toolSaveImage,
    images: deps?.images,
    completeJson,
  }))
  ctx.tools.register(generatePageTool({
    store,
    storeRoot,
    config,
    saveImage: toolSaveImage,
    images: deps?.images,
    completeJson,
    jobs: ctx.jobs,
  }))
  ctx.tools.register(editSectionTool({
    store,
    storeRoot,
    config,
    saveImage: toolSaveImage,
    images: deps?.images,
  }))
  ctx.tools.register(exportPageTool({ store }))
  ctx.tools.register(jobStatusTool({ store, jobs: ctx.jobs }))
  ctx.tools.register(jobCancelTool({ jobs: ctx.jobs }))
}
