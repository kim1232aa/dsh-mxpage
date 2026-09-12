/**
 * Port: Logger / usage sink.
 *
 * Replaces upstream's hard import
 *   `import { inferCategory, logApiUsage } from "@/lib/monitor/api-usage"`
 * which is the ONLY coupling preventing `openai-compatible.ts` (1344 lines)
 * from being framework-free.
 */

export interface UsageEvent {
  /** HTTP path that produced this event, e.g. `/images/generations`. */
  endpoint?: string
  method?: string
  model?: string
  status?: number
  ok: boolean
  durationMs?: number
  /** bytes sent / received, when known */
  requestBytes?: number
  responseBytes?: number
  /** multi-candidate base-URL attempts collapsed into this one event */
  attemptCount?: number
  collapsedAttempts?: Array<{ url: string; status: number }>
  retrySummary?: string
  finalEndpoint?: string
  category?: UsageCategory
  errorMessage?: string
  /** correlation */
  projectId?: string
  sectionId?: string
  operation?: string
}

export type UsageCategory =
  | 'text'
  | 'structured'
  | 'vision'
  | 'image_generation'
  | 'image_edit'
  | 'models'
  | 'unknown'

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  /** Usage accounting. Hosts may persist, aggregate, or drop this. */
  usage(event: UsageEvent): void
}

/** Derives a usage category from a request URL and an optional parsed/raw body. */
export function inferCategory(
  url: string,
  body?: string | Record<string, unknown> | null,
): UsageCategory {
  const serialized =
    typeof body === 'string' ? body : body ? JSON.stringify(body) : ''
  if (/\/images\/edits/i.test(url)) return 'image_edit'
  if (/\/images\/generations/i.test(url)) return 'image_generation'
  if (/\/chat\/completions/i.test(url)) {
    return /"response_format"/.test(serialized) ? 'structured' : 'text'
  }
  if (/generateContent/i.test(url)) return 'image_generation'
  if (/\/models/i.test(url)) return 'models'
  return 'unknown'
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  usage() {},
}

/** Wraps a partial logger so callers can supply only what they need. */
export function createLogger(partial?: Partial<Logger>): Logger {
  return { ...noopLogger, ...partial }
}
