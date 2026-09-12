/**
 * Port: ProviderResolver.
 *
 * Replaces upstream's `getProviderAdapter()`, which:
 *   - reads `ProviderConfig` + `ModelProfile` rows from Prisma, and
 *   - requires a per-request API key carried through `AsyncLocalStorage`
 *     (header `x-mxpage-api-key`) and *throws* without it.
 *
 * Notable upstream fact that makes this port cheap: `ProviderConfig.apiKeyEncrypted`
 * is always written as an empty string (`encryptSecret("")`), so there is no
 * server-side key material to migrate. The host owns credentials entirely.
 */

import type { CapabilityMap, ModelRoleMap } from '../types/domain.ts'

export interface ProviderModelRecord {
  modelId: string
  label?: string
  capabilities: CapabilityMap
  roles?: Partial<ModelRoleMap>
  isDefaultAnalysis?: boolean
  isDefaultPlanning?: boolean
  isDefaultHeroImage?: boolean
  isDefaultDetailImage?: boolean
  isDefaultImageEdit?: boolean
}

export interface ResolvedProvider {
  /** Opaque host identifier, surfaced for diagnostics only. */
  id?: string
  label?: string
  baseUrl: string
  apiKey: string
  models: ProviderModelRecord[]
}

/** Ambient scope forwarded from the caller (project, section, operation). */
export interface ProviderScope {
  projectId?: string
  sectionId?: string
  operation?: string
  /** Host-specific override, e.g. a channel chosen for this one call. */
  channelId?: string
}

export interface ProviderResolver {
  resolve(scope?: ProviderScope): Promise<ResolvedProvider>
}

/** Thrown when no usable channel is configured. */
export class ProviderUnavailableError extends Error {
  readonly code = 'MXPAGE_NO_IMAGE_KEY'
  constructor(message = 'no provider channel configured') {
    super(message)
    this.name = 'ProviderUnavailableError'
  }
}
