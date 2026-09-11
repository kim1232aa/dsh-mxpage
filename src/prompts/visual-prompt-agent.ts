import type { VisualStyleGuide } from '../schemas/section-plan.ts'

export type VpaMode = 'ecommerce_section' | 'xiaohongshu_page' | 'image_edit'
export type PromptLanguage = 'zh-CN' | 'en' | 'ja' | 'ko'

export interface VisualPromptAgentInput {
  mode: VpaMode
  title: string
  goal: string
  copy: string
  basePrompt: string
  aspectRatio: '1:1' | '3:4' | '9:16'
  contentLanguage?: PromptLanguage
  referenceRoles?: Array<{ role: string; isMain: boolean }>
  productContext?: unknown
  visualStyleGuide?: VisualStyleGuide
}

const STYLE_LABELS: Record<keyof VisualStyleGuide, string> = {
  styleName: '风格名称',
  colorPalette: '主色 / 辅助色',
  backgroundSystem: '背景系统',
  lighting: '光线方向',
  cameraLanguage: '镜头语言',
  typography: '字体气质',
  layoutRules: '版式密度',
  propRules: '道具规则',
  productRenderingRules: '商品表现规则',
  negativeStyleConstraints: '负面约束',
}

function styleGuideToPrompt(guide: VisualStyleGuide): string {
  return (Object.keys(STYLE_LABELS) as Array<keyof VisualStyleGuide>)
    .map((key) => `${STYLE_LABELS[key]}: ${guide[key]}`)
    .join('\n')
}

function summarizeReferences(input: VisualPromptAgentInput): string {
  const roles = input.referenceRoles ?? []
  if (roles.length === 0) return 'No reference images.'
  return `Reference roles: ${roles.map((item) => `${item.role}${item.isMain ? ' (main product)' : ''}`).join(' / ')}`
}

export function buildVisualPromptAgentPrompt(input: VisualPromptAgentInput): string {
  const modeGuide =
    input.mode === 'xiaohongshu_page'
      ? `Create a production-grade prompt for one Xiaohongshu ${input.aspectRatio} carousel image.`
      : input.mode === 'image_edit'
        ? 'Create a production-grade prompt for editing an existing image while preserving identity and composition continuity.'
        : 'Create a production-grade prompt for one e-commerce product detail page image.'

  return [
    'You are the system-level Visual Prompt Agent for an AI commerce design workflow.',
    '只输出一个 JSON 对象。',
    'Your job is to analyze the task before image generation and write a detailed final prompt for the image model.',
    'Return strict JSON only. No markdown.',
    '',
    modeGuide,
    '',
    'The finalPrompt must be detailed and directly usable by an image generation/editing model.',
    'It must include:',
    '- business objective and target audience',
    '- canvas aspect ratio and crop',
    '- product/subject identity rules from reference images, especially the main product image as the non-negotiable source of truth',
    '- foreground, middle ground, background, props, scene, camera angle, product placement',
    '- lighting, material texture, color palette, depth, shadows and reflections',
    '- in-image typography: title position, hierarchy, copy blocks, CTA/badges, safe margins',
    '- product-specific physical rules and impossible phenomena to avoid',
    '- final quality bar for a polished Xiaohongshu/e-commerce visual',
    '- if a project-level visual style guide is provided, repeat and obey it as the highest-priority visual consistency contract',
    '',
    'Important constraints:',
    '- 几何不可反转：外形、开口、铰链、层数、部件方向必须正确，禁止镜像错结构。',
    '- 禁止逆风：气流/液体/热量只从真实出口出去，禁止从进风口或反向喷出。',
    '- 主体与参考图一致：Preserve the product/object identity from reference images. Do not invent a different product.',
    '- 避免乱码文字：All visible text must be clear, correctly spelled, and in the target content language.',
    '- Do not create category mistakes or impossible mechanics: no reversed airflow, cables entering furniture, floating unsupported objects, liquid flowing upward, broken shadows, impossible reflections, wrong hinges/openings, wrong cube layer count, wrong tile grid, wrong corner/edge/center structure, or hands passing through objects.',
    '- Avoid vague words alone. Make every visual choice concrete.',
    '- For e-commerce sections, hero images and detail images must look like one cohesive commercial page.',
    '- If reference images are attached, analyze them as geometry/style references, but do not describe them as "uploaded image" inside the final artwork.',
    '- Do not infer the product from file names.',
    '',
    'Task context:',
    JSON.stringify(
      {
        mode: input.mode,
        title: input.title,
        goal: input.goal,
        copy: input.copy,
        basePrompt: input.basePrompt,
        aspectRatio: input.aspectRatio,
        contentLanguage: input.contentLanguage ?? 'zh-CN',
        references: summarizeReferences(input),
        productContext: input.productContext ?? null,
        visualStyleGuide: input.visualStyleGuide ? styleGuideToPrompt(input.visualStyleGuide) : null,
      },
      null,
      2,
    ),
    '',
    'Return this JSON shape:',
    `{
  "analysisSummary": "short analysis of the image strategy",
  "finalPrompt": "long detailed prompt for the image model",
  "negativePrompt": "what must not appear",
  "qualityChecklist": ["check 1", "check 2", "check 3"]
}`,
  ].join('\n')
}

export function buildVisualPromptRepairPrompt(raw: string): string {
  return [
    'You repair malformed visual-prompt-agent output into one strict JSON object.',
    '只输出一个 JSON 对象。',
    'finalPrompt must be at least 20 characters.',
    '几何不可反转、禁止逆风、主体与参考图一致、避免乱码文字。',
    'Target JSON shape:',
    `{
  "analysisSummary": "string",
  "finalPrompt": "string min 20 chars",
  "negativePrompt": "string",
  "qualityChecklist": ["string"]
}`,
    '',
    'Source content to repair:',
    raw,
  ].join('\n')
}
