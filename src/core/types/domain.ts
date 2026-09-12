/**
 * MxPage domain types — Prisma-free.
 *
 * Derived 1:1 from the upstream Prisma schema (ziguishian/MxPage,
 * `prisma/schema.prisma`, 7 models / 6 enums) so that a repository
 * implementation can port the schema verbatim to SQLite or JSON.
 *
 * Intentional changes vs upstream:
 *  - `@prisma/client` types replaced by local structural types.
 *  - Dead enum members dropped: `ProjectStatus.COMPLETED` and
 *    `GenerationStatus.QUEUED` are never written by any upstream service.
 *  - Prisma's `Json` columns become `unknown` / `Record<string, unknown>`.
 */

// ---------------------------------------------------------------------------
// Enums (string unions — value-compatible with the upstream Prisma enums)
// ---------------------------------------------------------------------------

export const PROJECT_STATUSES = ['DRAFT', 'ANALYZED', 'PLANNED', 'EDITING'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const ASSET_TYPES = [
  'MAIN',
  'ANGLE',
  'DETAIL',
  'REFERENCE',
  'GENERATED',
  'EXPORTED',
] as const
export type AssetType = (typeof ASSET_TYPES)[number]

export const SECTION_TYPES = [
  'HERO',
  'SELLING_POINTS',
  'SCENARIO',
  'DETAIL_CLOSEUP',
  'SPECS',
  'MATERIAL',
  'COMPARISON',
  'GIFT_SCENE',
  'BRAND_TRUST',
  'SUMMARY',
  'CUSTOM',
] as const
export type SectionType = (typeof SECTION_TYPES)[number]

export const GENERATION_STATUSES = ['IDLE', 'GENERATING', 'SUCCESS', 'FAILED'] as const
export type GenerationStatus = (typeof GENERATION_STATUSES)[number]

export const TASK_TYPES = [
  'ANALYZE',
  'PLAN',
  'GENERATE',
  'REGENERATE',
  'EXPORT',
  'BATCH_CREATE',
  'TRANSLATE_PAGE',
  'XHS_GENERATE',
  'QA_CHECK',
] as const
export type TaskType = (typeof TASK_TYPES)[number]

export const TASK_STATUSES = ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELED'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 * Upstream stores `platform` as free text but uses this sentinel to hide the
 * lazily-created placeholder project that owns batch / XHS workflow tasks.
 */
export const SYSTEM_TASK_PLATFORM = '__mxpage_system_task__'

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Project-level settings. Upstream keeps these in `Project.modelSnapshot` (Json). */
export interface PreviewConfig {
  heroImageCount: number
  detailSectionCount: number
  /**
   * Optional because upstream stores partial patches too: `planSections` writes
   * only the two counts in some paths, and `readPreviewConfig` normalizes with
   * defaults on read.
   */
  imageAspectRatio?: '1:1' | '3:4' | '9:16'
  contentLanguage?: string
}

export interface GenerationSettings {
  allowSvgFallback: boolean
}

export interface ModelSnapshot {
  previewConfig?: PreviewConfig
  generationSettings?: GenerationSettings
  visualStyleGuide?: Record<string, string>
  analysisModelId?: string
  planningModelId?: string
  providerConfigId?: string
  previewConfigSource?: string
  previewConfigReason?: string
  [key: string]: unknown
}

export interface Project {
  id: string
  name: string
  status: ProjectStatus
  platform: string
  style: string
  description?: string | null
  /** Required (nullable) so repository reads structurally satisfy service params. */
  modelSnapshot: ModelSnapshot | null
  createdAt: Date
  updatedAt: Date
}

export interface ProductAsset {
  id: string
  projectId: string
  sectionId?: string | null
  type: AssetType
  /** Path RELATIVE to the storage root. Always stored POSIX-normalized. */
  filePath: string
  fileName: string
  mimeType?: string | null
  sortOrder: number
  metadata?: Record<string, unknown> | null
  isMain: boolean
  createdAt: Date
}

export interface ProductAnalysis {
  id: string
  projectId: string
  rawResult: unknown
  normalizedResult: unknown
  createdAt: Date
  updatedAt: Date
}

export interface PageSection {
  id: string
  projectId: string
  sectionKey: string
  type: SectionType
  title: string
  goal: string
  copy: string
  visualPrompt: string
  order: number
  status: GenerationStatus
  currentImageAssetId?: string | null
  editableData?: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

export interface SectionVersion {
  id: string
  sectionId: string
  versionNumber: number
  promptSnapshot?: unknown
  copySnapshot?: unknown
  imageAssetId?: string | null
  isActive: boolean
  createdAt: Date
}

export interface GenerationTask {
  id: string
  projectId: string
  sectionId?: string | null
  taskType: TaskType
  status: TaskStatus
  inputPayload?: unknown
  /** The de-facto progress channel upstream: merged JSON, never a side table. */
  outputPayload?: Record<string, unknown> | null
  errorMessage?: string | null
  startedAt?: Date | null
  completedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Aggregates (what the services actually read)
// ---------------------------------------------------------------------------

export interface PageSectionWithVersions extends PageSection {
  versions: SectionVersion[]
}

export interface ProjectDetail extends Project {
  assets: ProductAsset[]
  analysis: ProductAnalysis | null
  sections: PageSectionWithVersions[]
}

// ---------------------------------------------------------------------------
// Client-facing projections
// ---------------------------------------------------------------------------

/** Upstream injects a `/api/files/...` URL here; a host may use a path instead. */
export interface AssetView extends ProductAsset {
  url: string
}

export interface SectionView extends PageSection {
  imageUrl: string | null
  versions: Array<SectionVersion & { imageUrl: string | null }>
}

export interface ProjectDetailView extends Project {
  coverImageUrl: string | null
  assets: AssetView[]
  analysis: ProductAnalysis | null
  sections: SectionView[]
}

// ---------------------------------------------------------------------------
// Presentation constants (ported from upstream `types/domain.ts`)
//
// Upstream asymmetry, preserved deliberately: section `type` is lowercase in
// TypeScript (`SectionTypeKey`) but UPPERCASE in the database (`SectionType`).
// `sections/[sectionId]/route.ts` did `.toUpperCase()` inbound and
// `export-service` did `.toLowerCase()` outbound for label lookup.
// ---------------------------------------------------------------------------

export const platformOptions = [
  'general_ecommerce',
  'taobao_tmall',
  'pinduoduo',
  'xiaohongshu',
  'douyin_ecommerce',
] as const
export type PlatformOption = (typeof platformOptions)[number]

export const platformLabels: Record<PlatformOption, string> = {
  general_ecommerce: '通用电商',
  taobao_tmall: '淘宝 / 天猫',
  pinduoduo: '拼多多',
  xiaohongshu: '小红书',
  douyin_ecommerce: '抖音电商',
}

export const styleOptions = [
  'generic_clean',
  'premium',
  'soft_lifestyle',
  'conversion_focused',
  'tech',
] as const
export type StyleOption = (typeof styleOptions)[number]

export const styleLabels: Record<StyleOption, string> = {
  generic_clean: '通用简洁',
  premium: '高级质感',
  soft_lifestyle: '柔和生活方式',
  conversion_focused: '转化导向',
  tech: '科技感',
}

export const assetTypeLabels: Record<AssetType, string> = {
  MAIN: '主商品图',
  ANGLE: '多角度图',
  DETAIL: '细节图',
  REFERENCE: '参考图',
  GENERATED: '生成图',
  EXPORTED: '导出文件',
}

/** Lowercase section keys — the shape prompt builders and plans speak. */
export const sectionTypeKeys = [
  'hero',
  'selling_points',
  'scenario',
  'detail_closeup',
  'specs',
  'material',
  'comparison',
  'gift_scene',
  'brand_trust',
  'summary',
  'custom',
] as const
export type SectionTypeKey = (typeof sectionTypeKeys)[number]

export const sectionTypeLabels: Record<SectionTypeKey, string> = {
  hero: '头图主视觉',
  selling_points: '卖点模块',
  scenario: '场景展示',
  detail_closeup: '细节特写',
  specs: '规格参数',
  material: '材质工艺',
  comparison: '对比说明',
  gift_scene: '送礼场景',
  brand_trust: '品牌信任',
  summary: '总结收口',
  custom: '自定义模块',
}

/** Lowercase prompt key → uppercase DB enum. */
export function toDbSectionType(key: string): SectionType {
  const upper = key.toUpperCase() as SectionType
  return (SECTION_TYPES as readonly string[]).includes(upper) ? upper : 'CUSTOM'
}

/** Uppercase DB enum → lowercase prompt key. */
export function toSectionTypeKey(type: string): SectionTypeKey {
  const lower = type.toLowerCase() as SectionTypeKey
  return (sectionTypeKeys as readonly string[]).includes(lower) ? lower : 'custom'
}

export const capabilityKeys = [
  'text',
  'vision',
  'image_gen',
  'image_edit',
  'structured_output',
  'fast',
  'cheap',
  'high_quality',
] as const
export type CapabilityKey = (typeof capabilityKeys)[number]

export const capabilityLabels: Record<CapabilityKey, string> = {
  text: '文本',
  vision: '视觉理解',
  image_gen: '图像生成',
  image_edit: '图像编辑',
  structured_output: '结构化输出',
  fast: '速度快',
  cheap: '成本低',
  high_quality: '高质量',
}

export type CapabilityMap = Record<CapabilityKey, boolean> & {
  /**
   * Upstream never populates these — endpoint probing is deliberately disabled
   * ("已跳过…避免消耗图像额度"), so name-regex inference is the only signal and a
   * gateway that lacks `/images/*` is discovered by *failing*. Hosts that do
   * probe may set them.
   */
  real_image_gen?: boolean
  real_image_edit?: boolean
}

export const roleKeys = ['analysis', 'planning', 'hero_image', 'detail_image', 'image_edit'] as const
export type ModelRoleKey = (typeof roleKeys)[number]

export const roleLabels: Record<ModelRoleKey, string> = {
  analysis: '商品分析',
  planning: '文案规划',
  hero_image: '头图生成',
  detail_image: '详情图生成',
  image_edit: '图像编辑',
}

export type ModelRoleMap = Record<ModelRoleKey, boolean>

export const statusLabels: Record<string, string> = {
  IDLE: '未开始',
  GENERATING: '生成中',
  SUCCESS: '已完成',
  FAILED: '失败',
  DRAFT: '草稿',
  ANALYZED: '已分析',
  PLANNED: '已规划',
  EDITING: '编辑中',
  PENDING: '排队中',
  RUNNING: '执行中',
  CANCELED: '已取消',
}

export type EndpointProbeState =
  | 'available'
  | 'unavailable'
  | 'rate_limited'
  | 'unknown'
  | 'not_applicable'

export interface ModelEndpointSupport {
  imageGeneration: EndpointProbeState
  imageEdit: EndpointProbeState
  note?: string | null
}

export interface ModelDetectionResult {
  modelId: string
  label: string
  capabilities: CapabilityMap
  roles: ModelRoleMap
  quality?: string | null
  latency?: string | null
  cost?: string | null
  isAvailable: boolean
  endpointSupport?: ModelEndpointSupport
}

export interface ProviderConnectionInput {
  name: string
  baseUrl: string
  apiKey: string
}

/** Normalized analysis result as consumed by the planner. */
export interface ProductAnalysisResult {
  productName: string
  category: string
  subcategory: string
  material: string
  color: string
  styleTags: string[]
  targetAudience: string[]
  usageScenarios: string[]
  coreSellingPoints: string[]
  differentiationPoints: string[]
  userConcerns: string[]
  recommendedFocusPoints: string[]
  additionalInformation: string
  generationRequirements: string
  suggestedSectionPlan: Array<{ type: string; title: string; goal: string }>
}

export interface PlannedSectionInput {
  id: string
  type: SectionTypeKey
  title: string
  goal: string
  copy: string
  visualPrompt: string
  imageStatus: GenerationStatus | 'idle' | 'queued' | 'generating' | 'success' | 'failed'
  imageUrl?: string | null
  editableFields: Record<string, unknown>
}
