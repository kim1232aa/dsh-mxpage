export interface AnalysisAssetHint {
  role: string
  isMain: boolean
}

const requiredJsonShape = `{
  "productName": "string",
  "category": "string",
  "subcategory": "string",
  "material": "string",
  "color": "string",
  "styleTags": ["string"],
  "targetAudience": ["string"],
  "usageScenarios": ["string"],
  "coreSellingPoints": ["string"],
  "differentiationPoints": ["string"],
  "userConcerns": ["string"],
  "recommendedFocusPoints": ["string"],
  "additionalInformation": "string",
  "generationRequirements": "string",
  "suggestedSectionPlan": [
    {
      "type": "hero | selling_points | scenario | detail_closeup | specs | material | comparison | gift_scene | brand_trust | summary | custom",
      "title": "string",
      "goal": "string"
    }
  ]
}`

const supportedSectionTypes = [
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
].join(', ')

const PHYSICAL_REALISM = [
  '物理真实约束（必须写入 additionalInformation / generationRequirements）：',
  '- 几何不可反转：外形、开口、铰链、层数、部件方向必须与主图一致，禁止镜像错结构。',
  '- 禁止逆风：气流/液体/热量只从真实出口出去，禁止从进风口反向喷出。',
  '- 主体与参考图一致：颜色、材质、比例、可动结构与识别特征锚定主图，禁止换成别的商品。',
  '- 避免乱码文字：后续出图时图内文案必须清晰、拼写正确、无乱码。',
].join('\n')

export function buildProductAnalysisPrompt(assets: AnalysisAssetHint[]): string {
  const assetSummary = assets
    .map((asset, index) => `${index + 1}. role=${asset.role}; isMain=${asset.isMain ? 'yes' : 'no'}`)
    .join('\n')

  return [
    'You are a senior e-commerce product strategist and detail-page planner.',
    '只输出一个 JSON 对象。',
    'Analyze the provided product images and asset role hints, then return one strict JSON object only. The main image is the factual source of truth for what the product actually is.',
    'Do not output markdown, code fences, explanations, comments, or extra keys.',
    'Do not infer the product from file names or path strings; only use the attached images and role hints.',
    'All copy values should be written in Simplified Chinese.',
    'If some attributes are uncertain, infer the most likely answer from the images and keep the field non-empty. Do not misclassify the product by overfitting to props, rulers, labels, packaging, or background objects.',
    '',
    'Available assets (roles only, not file names):',
    assetSummary || 'No uploaded assets.',
    '',
    'Required rules:',
    '1. Every required key must exist.',
    '2. Every array field must be an array of short Chinese strings.',
    '3. suggestedSectionPlan must contain at least 6 sections.',
    `4. suggestedSectionPlan.type must be one of: ${supportedSectionTypes}.`,
    '5. Focus on e-commerce conversion, visual hierarchy, and section planning, but every section must fit the real product category and mechanics shown in the main image.',
    '6. First identify the exact product object, its category, visual structure, count of repeated parts, operation/mechanism, and what it must never be mistaken for. Put this into additionalInformation.',
    '7. For puzzle cubes / speed cubes / Rubik-like cubes, explicitly capture: cube order such as 3x3x3 if visible, six colored faces, corner/edge/center pieces, twistable layers, seams, tile/sticker style, size if inferable, target users, and avoid treating it as a sticker craft, ruler, storage box, electronics product, or generic block.',
    '8. additionalInformation must summarize important extra facts for generation, especially product dimensions if visible or inferable. Include placeholders for unknown but required facts: size, weight/capacity/power, compatible specifications, package contents, usage constraints, and safety notes.',
    '',
    PHYSICAL_REALISM,
    '',
    'Return exactly this JSON shape:',
    requiredJsonShape,
  ].join('\n')
}

export function buildProductAnalysisRepairPrompt(raw: string): string {
  return [
    'You repair malformed product-analysis output into one strict JSON object.',
    '只输出一个 JSON 对象。',
    'Return JSON only. No markdown, no explanations, no extra keys.',
    'All string values should be in Simplified Chinese when possible.',
    'If a field is missing, infer a reasonable non-empty value from the source content.',
    'If suggestedSectionPlan is missing or too short, create at least 6 valid sections.',
    'If additionalInformation is missing, create a concise Chinese checklist covering size, weight/capacity/power, compatible specifications, package contents, usage constraints, and safety notes. Mark uncertain values as 待用户补充 instead of inventing exact numbers.',
    `Valid section types: ${supportedSectionTypes}.`,
    PHYSICAL_REALISM,
    '',
    'Target JSON shape:',
    requiredJsonShape,
    '',
    'Source content to repair:',
    raw,
  ].join('\n')
}
