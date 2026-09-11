import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import type { ImagesClient } from '../provider/openai-images.ts'
import { resolveCompleteJson, type CompleteJson } from '../provider/vision-text.ts'
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
      mediaType: 'image/png'
      name?: string
    }) => Promise<{ attachmentId: string }>
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

export function registerMxpageTools(
  ctx: MxpageToolsHost,
  config: Config,
  deps?: RegisterMxpageToolsDeps,
): void {
  const storeRoot = resolveStoreRoot(config)
  const store = createStore(storeRoot)
  const completeJson = resolveCompleteJson({
    completeJson: deps?.completeJson,
    llm: deps?.llm ?? ctx.llm,
    config,
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
