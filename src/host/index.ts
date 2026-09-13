/**
 * Host assembly: wires the five port implementations plus every core service
 * into one runtime object.
 *
 * This is the ONLY place that knows about both `mxpage-core` and the DSH
 * environment, which is what keeps `src/core/**` host-agnostic.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../config.ts'
import { createAnalysisService, type AnalysisService } from '../core/services/analysis-service.ts'
import { createAssetStore, type AssetStore } from '../core/services/asset-store.ts'
import { createExportService, type ExportService } from '../core/services/export-service.ts'
import {
  createGenerationService,
  type GenerationService,
} from '../core/services/generation-service.ts'
import { createPlannerService, type PlannerService } from '../core/services/planner-service.ts'
import { createTaskService, type TaskService } from '../core/services/task-service.ts'
import {
  createXiaohongshuService,
  type XiaohongshuService,
} from '../core/services/xiaohongshu-service.ts'
import type { CoreHost } from '../core/ports/index.ts'
import type { Logger } from '../core/ports/logger.ts'
import type { TaskRunner } from '../core/ports/tasks.ts'
import { createFileLogger } from './logger.ts'
import { createProviderResolver } from './provider-resolver.ts'
import { createJsonRepository } from './repository.ts'
import { createFileStorageDriver } from './storage-driver.ts'
import { createJobsTaskRunner, type JobsRegistryLike } from './jobs-task-runner.ts'
import { createQueuedTaskRunner } from './task-runner.ts'
import { createFallbackTaskRunner } from './fallback-task-runner.ts'

export interface MxpageRuntime {
  host: Required<CoreHost>
  storeRoot: string
  assets: AssetStore
  tasks: TaskService
  analysis: AnalysisService
  planner: PlannerService
  generation: GenerationService
  exportService: ExportService
  xiaohongshu: XiaohongshuService
  runner: TaskRunner
  logger: Logger
}

/**
 * Resolves the project root. Mirrors v0.1's layout (`$DSH_HOME/mxpage`) so
 * existing work is picked up rather than orphaned.
 */
export function resolveStoreRoot(config: Config): string {
  if (config.workspaceDir && config.workspaceDir.trim()) return config.workspaceDir.trim()
  return join(process.env.DSH_HOME ?? homedir(), 'mxpage')
}

export function createMxpageRuntime(
  config: Config,
  options: {
    /** The DSH host job registry (`ctx.jobs`), when the profile provides one. */
    jobs?: JobsRegistryLike
    /** Live agent that owns jobs, resolved at call time. */
    resolveOwner?: () => unknown
  } = {},
): MxpageRuntime {
  const storeRoot = resolveStoreRoot(config)

  const logger = createFileLogger({ ledgerDir: storeRoot })
  const repository = createJsonRepository({ file: join(storeRoot, 'db.json') })
  const storage = createFileStorageDriver(storeRoot)
  const provider = createProviderResolver({ config, logger })
  // Prefer the host job registry: the shell then owns job identity, session
  // scoping, lifecycle, completion notices and owner-disposal cancellation.
  // The local queue is the fallback — both for hosts without a `jobs` service
  // and for profiles where the registry exists but refuses this plugin's work
  // ("no job controller serves this agent" surfaces only as a synchronous
  // throw from `start`, hence the wrapping fallback runner).
  const localRunner = createQueuedTaskRunner({
    repository,
    concurrency: Math.max(1, config.maxParallelSections),
  })
  const runner = options.jobs
    ? createFallbackTaskRunner(
        createJobsTaskRunner({
          jobs: options.jobs,
          repository,
          resolveOwner: options.resolveOwner,
        }),
        localRunner,
      )
    : localRunner

  const host: Required<CoreHost> = { repository, storage, provider, logger, tasks: runner }

  const assets = createAssetStore(host)
  const tasks = createTaskService(host)
  const analysis = createAnalysisService(host, { taskService: tasks, assetStore: assets })
  const planner = createPlannerService(host, { tasks, assets })
  const generation = createGenerationService(host, { tasks, assets })
  const exportService = createExportService(host, { assetStore: assets, taskService: tasks })
  const xiaohongshu = createXiaohongshuService(host)

  return {
    host,
    storeRoot,
    assets,
    tasks,
    analysis,
    planner,
    generation,
    exportService,
    xiaohongshu,
    runner,
    logger,
  }
}
