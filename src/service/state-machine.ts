export type STATUS =
  | 'created'
  | 'analyzing'
  | 'analyzed'
  | 'planning'
  | 'planned'
  | 'generating'
  | 'generated'
  | 'editing'
  | 'failed'

const TRANSITIONS: Record<STATUS, readonly STATUS[]> = {
  created: ['analyzing', 'failed'],
  analyzing: ['analyzed', 'failed'],
  analyzed: ['planning', 'failed'],
  planning: ['planned', 'failed'],
  planned: ['planning', 'generating', 'editing', 'failed'],
  generating: ['generated', 'failed'],
  generated: ['editing', 'generating', 'failed'],
  editing: ['generated', 'failed'],
  failed: ['analyzing', 'planning', 'generating', 'editing'],
}

export function assertTransition(from: STATUS, to: STATUS): STATUS {
  const allowed = TRANSITIONS[from]
  if (!allowed?.includes(to)) {
    throw new Error(`illegal status transition: ${from} → ${to}`)
  }
  return to
}
