export interface SuggestedSectionPlanItem {
  type: string
  title: string
  goal: string
}

export interface ProductAnalysisOutput {
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
  suggestedSectionPlan: SuggestedSectionPlanItem[]
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid analysis: expected object')
  }
  return value as Record<string, unknown>
}

function requiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid analysis: missing ${key}`)
  }
  return value
}

function optionalString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`invalid analysis: missing ${key}`)
  return value
}

function stringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key]
  if (!Array.isArray(value)) throw new Error(`invalid analysis: missing ${key}`)
  return value.map((item) => String(item))
}

function parseSuggested(value: unknown): SuggestedSectionPlanItem[] {
  if (!Array.isArray(value)) throw new Error('invalid analysis: missing suggestedSectionPlan')
  return value.map((item) => {
    const rec = asRecord(item)
    return {
      type: requiredString(rec, 'type'),
      title: requiredString(rec, 'title'),
      goal: requiredString(rec, 'goal'),
    }
  })
}

export function parseProductAnalysis(value: unknown): ProductAnalysisOutput {
  const obj = asRecord(value)
  return {
    productName: requiredString(obj, 'productName'),
    category: requiredString(obj, 'category'),
    subcategory: requiredString(obj, 'subcategory'),
    material: requiredString(obj, 'material'),
    color: requiredString(obj, 'color'),
    styleTags: stringArray(obj, 'styleTags'),
    targetAudience: stringArray(obj, 'targetAudience'),
    usageScenarios: stringArray(obj, 'usageScenarios'),
    coreSellingPoints: stringArray(obj, 'coreSellingPoints'),
    differentiationPoints: stringArray(obj, 'differentiationPoints'),
    userConcerns: stringArray(obj, 'userConcerns'),
    recommendedFocusPoints: stringArray(obj, 'recommendedFocusPoints'),
    additionalInformation: optionalString(obj, 'additionalInformation'),
    generationRequirements: optionalString(obj, 'generationRequirements'),
    suggestedSectionPlan: parseSuggested(obj.suggestedSectionPlan),
  }
}
