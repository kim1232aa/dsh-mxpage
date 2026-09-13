/**
 * API usage monitor — host-agnostic core.
 *
 * Port of upstream `lib/monitor/api-usage.ts` (the read half): the upstream
 * module coupled Prisma-era entry shaping, quota classification and the
 * humanizer to `fs` + `process.cwd()`. Here the module is pure: the host
 * passes raw ledger lines in, and gets normalized entries, filters and the
 * summary aggregate back. No fs, no env — B3-safe.
 *
 * The write half stays where it always was in the plugin: the Logger port's
 * `usage(event)` (`src/host/logger.ts` appends `usage.jsonl`).
 */

import type { UsageCategory } from '../ports/logger.ts'

// ---------------------------------------------------------------------------
// entry shape
// ---------------------------------------------------------------------------

export type QuotaState = 'ok' | 'rate_limited' | 'spending_limited' | 'auth_error' | 'other_error'

export interface MonitorEntry {
  id: string
  at: string
  endpoint: string
  method: string
  model: string | null
  status: number
  ok: boolean
  durationMs: number
  requestBytes: number
  responseBytes: number
  attemptCount: number
  retrySummary: string | null
  category: UsageCategory
  quotaState: QuotaState
  errorMessage: string | null
  projectId: string | null
  sectionId: string | null
  operation: string | null
}

/**
 * Normalizes one raw ledger line (the plugin's `{ at, ...event }` JSONL shape)
 * into a MonitorEntry. Unparseable / non-object input returns null so callers
 * can filter. `fallbackId` keeps delete-by-id stable for lines without one.
 */
export function normalizeLedgerEntry(raw: unknown, fallbackId: string): MonitorEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const status = typeof record.status === 'number' ? record.status : 0
  const ok = record.ok === true
  const errorMessage =
    typeof record.errorMessage === 'string' && record.errorMessage.trim()
      ? record.errorMessage
      : null
  const category =
    typeof record.category === 'string' && record.category
      ? (record.category as UsageCategory)
      : 'unknown'
  return {
    id: typeof record.id === 'string' && record.id ? record.id : fallbackId,
    at: typeof record.at === 'string' ? record.at : new Date(0).toISOString(),
    endpoint: typeof record.endpoint === 'string' ? record.endpoint : '?',
    method: typeof record.method === 'string' ? record.method : 'POST',
    model: typeof record.model === 'string' ? record.model : null,
    status,
    ok,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    requestBytes: typeof record.requestBytes === 'number' ? record.requestBytes : 0,
    responseBytes: typeof record.responseBytes === 'number' ? record.responseBytes : 0,
    attemptCount: typeof record.attemptCount === 'number' ? record.attemptCount : 1,
    retrySummary: typeof record.retrySummary === 'string' ? record.retrySummary : null,
    category,
    quotaState: classifyQuotaState(status, errorMessage ?? ''),
    errorMessage,
    projectId: typeof record.projectId === 'string' ? record.projectId : null,
    sectionId: typeof record.sectionId === 'string' ? record.sectionId : null,
    operation: typeof record.operation === 'string' ? record.operation : null,
  }
}

// ---------------------------------------------------------------------------
// quota classification + humanizer (ported verbatim from upstream)
// ---------------------------------------------------------------------------

export function classifyQuotaState(statusCode: number, body: string): QuotaState {
  const text = body.toLowerCase()
  if (
    /monthly spending limit|spending limit|quota|insufficient_quota|billing|可用余额不足|余额不足|充值后再使用/i.test(
      body,
    )
  ) {
    return 'spending_limited'
  }
  if (statusCode === 429 || /rate limit|限流/i.test(body)) {
    return 'rate_limited'
  }
  if (statusCode === 401 || statusCode === 403 || /invalid token|unauthorized|forbidden/i.test(text)) {
    return 'auth_error'
  }
  if (statusCode >= 400) {
    return 'other_error'
  }
  return 'ok'
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function extractRawMessage(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  const parsed = tryParseJson(trimmed) as Record<string, any> | null
  if (parsed && typeof parsed === 'object') {
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? null
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  const embeddedJsonMatch = trimmed.match(/\{[\s\S]*\}$/)
  if (embeddedJsonMatch) {
    const embedded = tryParseJson(embeddedJsonMatch[0]) as Record<string, any> | null
    const embeddedMessage = embedded?.error?.message ?? embedded?.message ?? embedded?.detail ?? null
    if (typeof embeddedMessage === 'string' && embeddedMessage.trim()) return embeddedMessage.trim()
  }
  return trimmed
}

function fallbackMessageByStatus(statusCode: number): string {
  if (statusCode === 401 || statusCode === 403) {
    return '当前 API Key 无效、无权限，或已被额度策略拒绝。'
  }
  if (statusCode === 404) return '当前接口或模型在代理商侧不可用。'
  if (statusCode === 408 || statusCode === 504) return '请求超时，请稍后重试。'
  if (statusCode === 429) return '当前请求触发了限流，请稍后再试。'
  if (statusCode >= 500) return '代理商服务暂时不可用，请稍后重试。'
  return '请求失败，请检查配置或稍后重试。'
}

export function humanizeApiMonitorMessage(input: {
  message: string | null | undefined
  statusCode?: number | null
}): string | null {
  const statusCode = input.statusCode ?? 0
  const raw = extractRawMessage(input.message)
  if (!raw) return statusCode >= 400 ? fallbackMessageByStatus(statusCode) : null

  const normalized = raw.toLowerCase()

  if (
    /monthly spending limit|spending limit|insufficient_quota|quota.*exceed|quota exceeded|billing|可用余额不足|余额不足|充值后再使用/i.test(
      raw,
    )
  ) {
    return '当前 API Key 已达到月度额度上限，请前往代理商后台提高或取消月度限额，或更换可用 Key。'
  }
  if (statusCode === 429 || /rate limit|触发限流|too many requests/i.test(raw)) {
    return '当前请求触发了限流，请稍后重试或降低调用频率。'
  }
  if (statusCode === 401 || /invalid token|unauthorized|forbidden|invalid api key|api key/i.test(normalized)) {
    return '当前 API Key 无效或无权限，请检查 API Key、代理地址和账户权限。'
  }
  if (/timed out|timeout|network error|fetch failed|socket hang up|econnreset|enotfound|econnrefused/i.test(normalized)) {
    return '网络请求失败或响应超时，请检查代理地址是否可达，或稍后重试。'
  }
  if (/this operation was aborted|aborterror/i.test(normalized)) {
    return '请求已被中止，通常是超时控制或探测流程主动停止。'
  }
  if (/no available endpoint found|get instance failed|real image generation endpoint/i.test(normalized)) {
    return '当前代理商没有为该模型提供可用端点，请更换模型或 Provider。'
  }
  if (/model .* does not exist|unknown model|invalid.*model|not found for model/i.test(normalized)) {
    return '当前模型在该代理商不可用，请重新发现模型并选择可用模型。'
  }
  if (/page not found|not found|unknown parameter|invalid type for 'images|invalid type for "images|expected an object/i.test(normalized)) {
    return '当前代理接口或参数格式与该能力不兼容，请检查代理商是否完整支持此图像接口。'
  }
  if (/invalid value/i.test(normalized) && /1024x1024|1024x1536|1536x1024|auto|size/i.test(normalized)) {
    return '当前图像尺寸参数不被该模型或代理商接受，系统需要切换到兼容尺寸。'
  }
  if (/image generation temporarily unavailable|图像生成接口暂时不可用/i.test(raw)) {
    return '图像生成接口暂时不可用，请稍后重试或更换可用模型。'
  }
  if (/malformed|json|schema/i.test(normalized)) {
    return '模型返回的结构化结果不符合预期，系统正在尝试自动修复。'
  }
  if (raw.length > 140) return `${raw.slice(0, 137)}...`
  return raw
}

/** Humanizes one entry's error fields in place (returns a copy). */
export function humanizeEntry(entry: MonitorEntry): MonitorEntry {
  return {
    ...entry,
    errorMessage: humanizeApiMonitorMessage({ message: entry.errorMessage, statusCode: entry.status }),
  }
}

// ---------------------------------------------------------------------------
// filter + summarize
// ---------------------------------------------------------------------------

export interface UsageQuery {
  hours?: number
  limit?: number
  page?: number
  projectId?: string | null
  category?: UsageCategory | 'all'
  quotaState?: QuotaState | 'all'
  success?: 'all' | 'success' | 'failed'
}

export interface UsageSummary {
  hours: number
  page: number
  pageSize: number
  totalPages: number
  totalRequests: number
  successRequests: number
  failedRequests: number
  chatRequests: number
  imageRequests: number
  spendingLimitedRequests: number
  rateLimitedRequests: number
  averageDurationMs: number
  topModels: Array<{ model: string; count: number }>
  topProjects: Array<{ projectId: string; count: number }>
  recentEntries: MonitorEntry[]
}

const IMAGE_CATEGORIES: ReadonlySet<UsageCategory> = new Set(['image_generation', 'image_edit'])
const CHAT_CATEGORIES: ReadonlySet<UsageCategory> = new Set(['text', 'structured', 'vision'])

export function summarizeUsage(entries: MonitorEntry[], options: UsageQuery = {}): UsageSummary {
  const hours = options.hours ?? 24
  const limit = options.limit ?? 50
  const page = Math.max(1, options.page ?? 1)
  const since = Date.now() - hours * 60 * 60 * 1000

  const filtered = entries.filter((entry) => {
    if (new Date(entry.at).getTime() < since) return false
    if (options.projectId && entry.projectId !== options.projectId) return false
    if (options.category && options.category !== 'all' && entry.category !== options.category) {
      return false
    }
    if (options.quotaState && options.quotaState !== 'all' && entry.quotaState !== options.quotaState) {
      return false
    }
    if (options.success === 'success' && !entry.ok) return false
    if (options.success === 'failed' && entry.ok) return false
    return true
  })

  const countBy = (key: (entry: MonitorEntry) => string) =>
    Object.entries(
      filtered.reduce<Record<string, number>>((accumulator, entry) => {
        const bucket = key(entry)
        accumulator[bucket] = (accumulator[bucket] ?? 0) + 1
        return accumulator
      }, {}),
    )
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)

  return {
    hours,
    page,
    pageSize: limit,
    totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
    totalRequests: filtered.length,
    successRequests: filtered.filter((entry) => entry.ok).length,
    failedRequests: filtered.filter((entry) => !entry.ok).length,
    chatRequests: filtered.filter((entry) => CHAT_CATEGORIES.has(entry.category)).length,
    imageRequests: filtered.filter((entry) => IMAGE_CATEGORIES.has(entry.category)).length,
    spendingLimitedRequests: filtered.filter((entry) => entry.quotaState === 'spending_limited').length,
    rateLimitedRequests: filtered.filter((entry) => entry.quotaState === 'rate_limited').length,
    averageDurationMs:
      filtered.length > 0
        ? Math.round(filtered.reduce((sum, entry) => sum + entry.durationMs, 0) / filtered.length)
        : 0,
    topModels: countBy((entry) => entry.model ?? 'unknown-model').map(([model, count]) => ({
      model,
      count,
    })),
    topProjects: countBy((entry) => entry.projectId ?? 'unassigned').map(([projectId, count]) => ({
      projectId,
      count,
    })),
    recentEntries: filtered.slice((page - 1) * limit, page * limit),
  }
}
