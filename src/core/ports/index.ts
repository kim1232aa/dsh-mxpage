/**
 * The five injection points that decouple `mxpage-core` from any host.
 *
 * Extracted from ziguishian/MxPage (MIT, 灵矩绘境). See ../../NOTICE.
 */

export * from './logger.ts'
export * from './provider.ts'
export * from './repository.ts'
export * from './storage.ts'
export * from './tasks.ts'

import type { Logger } from './logger.ts'
import type { ProviderResolver } from './provider.ts'
import type { Repository } from './repository.ts'
import type { StorageDriver } from './storage.ts'
import type { TaskRunner } from './tasks.ts'
import { noopLogger } from './logger.ts'
import { createInProcessTaskRunner } from './tasks.ts'

/** Everything a core service needs from its host. */
export interface CoreHost {
  repository: Repository
  storage: StorageDriver
  provider: ProviderResolver
  logger?: Logger
  tasks?: TaskRunner
}

/** Fills in the optional ports with safe defaults. */
export function resolveHost(host: CoreHost): Required<CoreHost> {
  return {
    repository: host.repository,
    storage: host.storage,
    provider: host.provider,
    logger: host.logger ?? noopLogger,
    tasks: host.tasks ?? createInProcessTaskRunner(),
  }
}
