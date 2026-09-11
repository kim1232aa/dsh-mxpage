export const SECTION_TYPES = [
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

export type SectionType = (typeof SECTION_TYPES)[number]

const SECTION_TYPE_SET = new Set<string>(SECTION_TYPES)

export interface VisualStyleGuide {
  styleName: string
  colorPalette: string
  backgroundSystem: string
  lighting: string
  cameraLanguage: string
  typography: string
  layoutRules: string
  propRules: string
  productRenderingRules: string
  negativeStyleConstraints: string
}

export interface PlannedSection {
  id: string
  type: SectionType
  title: string
  goal: string
  copy: string
  visualPrompt: string
  editableFields: Record<string, unknown>
}

export interface SectionPlanOutput {
  visualStyleGuide: VisualStyleGuide
  sections: PlannedSection[]
}

const STYLE_KEYS = [
  'styleName',
  'colorPalette',
  'backgroundSystem',
  'lighting',
  'cameraLanguage',
  'typography',
  'layoutRules',
  'propRules',
  'productRenderingRules',
  'negativeStyleConstraints',
] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function parseType(value: unknown): SectionType {
  const normalized = str(value).trim().toLowerCase()
  if (SECTION_TYPE_SET.has(normalized)) return normalized as SectionType
  return 'custom'
}

export function parseVisualStyleGuide(value: unknown): VisualStyleGuide {
  const rec = asRecord(value) ?? {}
  const guide = {} as VisualStyleGuide
  for (const key of STYLE_KEYS) {
    guide[key] = str(rec[key])
  }
  return guide
}

function parseSection(value: unknown): PlannedSection {
  const rec = asRecord(value) ?? {}
  const editable = asRecord(rec.editableFields) ?? {}
  return {
    id: str(rec.id),
    type: parseType(rec.type),
    title: str(rec.title),
    goal: str(rec.goal),
    copy: str(rec.copy),
    visualPrompt: str(rec.visualPrompt),
    editableFields: { ...editable },
  }
}

function unwrap(value: unknown): { visualStyleGuide: unknown; sections: unknown } {
  if (Array.isArray(value)) return { visualStyleGuide: undefined, sections: value }
  const rec = asRecord(value)
  if (!rec) throw new Error('invalid section plan: expected object')
  if (Array.isArray(rec.sections) || rec.visualStyleGuide !== undefined) {
    return { visualStyleGuide: rec.visualStyleGuide, sections: rec.sections }
  }
  const data = asRecord(rec.data)
  if (data && (Array.isArray(data.sections) || data.visualStyleGuide !== undefined)) {
    return { visualStyleGuide: data.visualStyleGuide, sections: data.sections }
  }
  const result = asRecord(rec.result)
  if (result && (Array.isArray(result.sections) || result.visualStyleGuide !== undefined)) {
    return { visualStyleGuide: result.visualStyleGuide, sections: result.sections }
  }
  throw new Error('invalid section plan: missing sections')
}

export function parseSectionPlan(value: unknown): SectionPlanOutput {
  const raw = unwrap(value)
  if (!Array.isArray(raw.sections)) throw new Error('invalid section plan: missing sections')
  return {
    visualStyleGuide: parseVisualStyleGuide(raw.visualStyleGuide),
    sections: raw.sections.map(parseSection),
  }
}
