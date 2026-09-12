/**
 * mxpage-core — the host-agnostic port of ziguishian/MxPage (MIT, 灵矩绘境).
 *
 * Everything under this directory talks to its host ONLY through the five ports
 * in `./ports`. It must never import `@deepseek-ai/*`, `schemastery`, Next.js,
 * Prisma, React, or touch `process.cwd()` / `process.env`.
 *
 * Extracted from upstream `lib/` (174-file repo). Verified facts that made this
 * extraction possible:
 *   - zero `next/*` imports inside `lib/`
 *   - `@prisma/client` appears 9 times, two of them type-only
 *   - the OpenAI-compatible adapter's only external coupling was one import
 */

// -- ports ------------------------------------------------------------------
export * from './ports/index.ts'
export type { Logger, UsageEvent, UsageCategory } from './ports/logger.ts'
export { createLogger, inferCategory, noopLogger } from './ports/logger.ts'
export type {
  ProviderModelRecord,
  ProviderResolver,
  ProviderScope,
  ResolvedProvider,
} from './ports/provider.ts'
export { ProviderUnavailableError } from './ports/provider.ts'
export type * from './ports/repository.ts'
export type { StorageDriver } from './ports/storage.ts'
export { normalizeRelPath } from './ports/storage.ts'
export type { TaskHandle, TaskRunner, TaskRunContext, TaskSpec } from './ports/tasks.ts'
export {
  assertNotCanceled,
  createInProcessTaskRunner,
  isTaskCanceledError,
  TaskCanceledError,
} from './ports/tasks.ts'

// -- types ------------------------------------------------------------------
export * from './types/domain.ts'

// -- utils ------------------------------------------------------------------
export * from './utils/content-language.ts'
export * from './utils/files.ts'
export * from './utils/visual-style-guide.ts'
export { createZip, type ZipEntry } from './utils/zip.ts'

// -- ai ---------------------------------------------------------------------
export * from './ai/provider-client.ts'
export * from './ai/capability-detector.ts'
export * from './ai/model-matcher.ts'
export * from './ai/schemas/product-analysis.ts'
export * from './ai/schemas/section-plan.ts'
export * from './ai/schemas/visual-prompt.ts'
export * from './ai/schemas/xiaohongshu.ts'
export * from './ai/prompts/index.ts'
export { OpenAICompatibleAdapter } from './ai/adapters/openai-compatible.ts'

// -- services ---------------------------------------------------------------
export * from './services/asset-store.ts'
export * from './services/task-service.ts'
export * from './services/visual-prompt-agent.ts'
export * from './services/analysis-service.ts'
export * from './services/planner-service.ts'
export * from './services/generation-service.ts'
export * from './services/xiaohongshu-service.ts'
export * from './services/export-service.ts'
