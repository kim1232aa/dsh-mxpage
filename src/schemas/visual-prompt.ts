export interface VisualPromptOutput {
  analysisSummary: string
  finalPrompt: string
  negativePrompt: string
  qualityChecklist: string[]
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid visual prompt: expected object')
  }
  return value as Record<string, unknown>
}

function optionalString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`invalid visual prompt: missing ${key}`)
  return value
}

export function parseVisualPrompt(value: unknown): VisualPromptOutput {
  const obj = asRecord(value)
  const finalPrompt = obj.finalPrompt
  if (typeof finalPrompt !== 'string' || finalPrompt.trim().length < 20) {
    throw new Error('invalid visual prompt: finalPrompt')
  }
  const checklist = obj.qualityChecklist
  if (checklist !== undefined && !Array.isArray(checklist)) {
    throw new Error('invalid visual prompt: qualityChecklist')
  }
  return {
    analysisSummary: optionalString(obj, 'analysisSummary'),
    finalPrompt,
    negativePrompt: optionalString(obj, 'negativePrompt'),
    qualityChecklist: Array.isArray(checklist) ? checklist.map((item) => String(item)) : [],
  }
}
