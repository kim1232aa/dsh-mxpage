import Schema from 'schemastery'

/**
 * One upstream channel: an OpenAI-compatible endpoint plus its model catalog.
 *
 * This replaces v0.1's single `MXPAGE_IMAGE_API_KEY` environment variable. The
 * upstream MxPage project keeps provider credentials in the *browser*
 * (`localStorage` + an `x-mxpage-api-key` header) and its server-side
 * `ProviderConfig.apiKeyEncrypted` column is always written as an empty string —
 * so there is no server-side key material to migrate, and a channel list is the
 * natural shape.
 */
export interface ChannelConfig {
  /** Stable id, used as the rotation key and in diagnostics. */
  id: string
  label?: string
  /** OpenAI-compatible base URL. A missing /v1 is handled by the adapter. */
  baseUrl: string
  /** Literal key. Prefer `apiKeyEnv` so secrets stay out of the settings doc. */
  apiKey?: string
  /** Name of an environment variable holding the key. */
  apiKeyEnv?: string
  /**
   * Explicit image model ids. When empty, the catalog is discovered with a
   * `GET /models` and classified by name (`capability-detector`).
   * NOTE: name-based classification is upstream's only signal — it deliberately
   * skips real endpoint probing to avoid burning image quota, so a gateway whose
   * `/models` lists a model it cannot actually render for is discovered by
   * failing.
   */
  models?: string[]
  /** Preferred text/vision model for analyze + plan on this channel. */
  textModel?: string
  /** Preferred image model for generate on this channel. */
  imageModel?: string
  disabled?: boolean
}

export interface Config {
  /** Ordered channel list. Rotation follows this order. */
  channels: ChannelConfig[]

  /** Project root. Defaults to `$DSH_HOME/mxpage`. */
  workspaceDir?: string

  defaultLanguage: 'zh-CN' | 'en' | 'ja' | 'ko'
  defaultHeroCount: number
  defaultDetailCount: number
  defaultDetailAspectRatio: '1:1' | '3:4' | '9:16'
  defaultPlatform: string
  defaultStyle: string

  /** Structured text/vision request budget (analyze + plan). Upstream: 180s. */
  analyzeTimeoutMs: number
  /** Visual Prompt Agent budget. Upstream: 60s. */
  promptTimeoutMs: number
  /** Per-image generation/edit budget. Upstream: 120s. */
  imageTimeoutMs: number

  maxReferenceImages: number
  maxAnalysisImages: number

  /** Concurrent section generations inside one page job. */
  maxParallelSections: number
  /** Concurrent projects for batch SKU runs. */
  maxParallelProjects: number

  /**
   * Upstream `shouldFallbackToNextImageModel` returns FALSE for
   * quota / 429 / 403 / 401, so an exhausted channel aborts the whole batch
   * instead of trying the next candidate. With a channel list that is the wrong
   * default, so the port makes it configurable rather than hard-coded.
   */
  rotateChannelOnQuotaExhausted: boolean

  /** SVG-poster fallback when no real image endpoint is available. */
  allowSvgFallback: boolean
}

export const Config: Schema<Config> = Schema.object({
  channels: Schema.array(
    Schema.object({
      id: Schema.string().required().description('渠道标识，用于轮换与诊断'),
      label: Schema.string().description('显示名'),
      baseUrl: Schema.string().required().description('OpenAI 兼容 base URL；缺 /v1 会自动尝试'),
      apiKey: Schema.string().role('secret').description('密钥明文（不推荐，优先用 apiKeyEnv）'),
      apiKeyEnv: Schema.string().description('存放密钥的环境变量名'),
      models: Schema.array(Schema.string()).description('图像模型 id；留空则用 GET /models 发现并按名称分类'),
      textModel: Schema.string().description('本渠道的分析/规划文本模型'),
      imageModel: Schema.string().description('本渠道的图像生成模型'),
      disabled: Schema.boolean().default(false),
    }),
  )
    .default([])
    .description('渠道列表，按顺序轮换'),

  workspaceDir: Schema.string().description('项目根目录，默认 $DSH_HOME/mxpage'),

  defaultLanguage: Schema.union(['zh-CN', 'en', 'ja', 'ko'] as const).default('zh-CN'),
  defaultHeroCount: Schema.number().default(3),
  defaultDetailCount: Schema.number().default(6),
  defaultDetailAspectRatio: Schema.union(['1:1', '3:4', '9:16'] as const).default('3:4'),
  defaultPlatform: Schema.string().default('general_ecommerce'),
  defaultStyle: Schema.string().default('generic_clean'),

  analyzeTimeoutMs: Schema.number().default(180_000),
  promptTimeoutMs: Schema.number().default(60_000),
  imageTimeoutMs: Schema.number().default(120_000),

  maxReferenceImages: Schema.number().default(4),
  maxAnalysisImages: Schema.number().default(10),

  maxParallelSections: Schema.number().default(2),
  maxParallelProjects: Schema.number().default(1),

  rotateChannelOnQuotaExhausted: Schema.boolean()
    .default(true)
    .description('上游对 429/额度 不轮换模型；多渠道下开启此项会换到下一个渠道'),

  allowSvgFallback: Schema.boolean().default(false),
}) as Schema<Config>
