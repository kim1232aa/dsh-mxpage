import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** 图像 API 根路径，需含 /v1 */
  imageBaseUrl: string
  /** 图像 API Key 所在环境变量名，不写明文 key */
  imageApiKeyEnv: string
  /** 默认图像模型 */
  imageModel: string
  /** 可选：独立文本/视觉端点。空则优先 ctx.llm */
  textBaseUrl?: string
  textApiKeyEnv?: string
  textModel?: string
  /** 项目根。空则 $DSH_HOME/mxpage/projects */
  workspaceDir?: string
  defaultLanguage: 'zh-CN' | 'en' | 'ja' | 'ko'
  defaultHeroCount: number
  defaultDetailCount: number
  defaultDetailAspectRatio: '3:4' | '9:16'
  timeoutMs: number
  analyzeTimeoutMs: number
  maxReferenceImages: number
  maxParallelSections: number
  /** 批量 SKU 同时进行的项目数，默认 1（串行） */
  maxParallelProjects?: number
  generateAsJob: boolean
  allowSvgFallback: boolean
}

export const Config: Schema<Config> = Schema.object({
  imageBaseUrl: Schema.string().default('https://api.openai.com/v1').description('图像 API 根路径，需含 /v1'),
  imageApiKeyEnv: Schema.string().default('MXPAGE_IMAGE_API_KEY').description('图像 API Key 所在环境变量名，不写明文 key'),
  imageModel: Schema.string().default('gpt-image-2').description('默认图像模型'),
  textBaseUrl: Schema.string().description('可选：独立文本/视觉端点。空则优先 ctx.llm'),
  textApiKeyEnv: Schema.string(),
  textModel: Schema.string(),
  workspaceDir: Schema.string().description('项目根。空则 $DSH_HOME/mxpage/projects'),
  defaultLanguage: Schema.union(['zh-CN', 'en', 'ja', 'ko'] as const).default('zh-CN'),
  defaultHeroCount: Schema.number().default(3),
  defaultDetailCount: Schema.number().default(6),
  defaultDetailAspectRatio: Schema.union(['3:4', '9:16'] as const).default('3:4'),
  timeoutMs: Schema.number().default(180_000),
  analyzeTimeoutMs: Schema.number().default(120_000),
  maxReferenceImages: Schema.number().default(4),
  maxParallelSections: Schema.number().default(2),
  maxParallelProjects: Schema.number().default(1).description('批量 SKU 同时进行的项目数，默认 1'),
  generateAsJob: Schema.boolean().default(true),
  allowSvgFallback: Schema.boolean().default(false),
}) as Schema<Config>
