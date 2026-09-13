/**
 * Host implementation of the ProviderResolver port.
 *
 * Maps the plugin's channel list onto `ResolvedProvider`, which is what
 * `mxpage-core` needs: `{ baseUrl, apiKey, models[] }`.
 *
 * Why this is cheap: upstream MxPage keeps provider credentials in the browser
 * (`localStorage` → `x-mxpage-api-key` header) and its server-side
 * `ProviderConfig.apiKeyEncrypted` column is always `encryptSecret("")`.
 * `getProviderAdapter()` *throws* without a request-scoped key. So there is no
 * server-side key store to migrate — a channel list is a drop-in replacement.
 *
 * Model catalog: when a channel lists `models` explicitly they are used as-is;
 * otherwise the catalog is discovered with `GET /models` and classified by name
 * via `normalizeDetectedModels`. Upstream never probes real image endpoints
 * ("已跳过…避免消耗图像额度"), so `real_image_gen` / `real_image_edit` stay
 * undefined and a gateway that advertises an image model it cannot serve is
 * discovered by failing. `discover: true` on a channel opts into one probe.
 */

import { OpenAICompatibleAdapter } from '../core/ai/adapters/openai-compatible.ts'
import { normalizeDetectedModels } from '../core/ai/capability-detector.ts'
import type { Logger } from '../core/ports/logger.ts'
import { noopLogger } from '../core/ports/logger.ts'
import {
  ProviderUnavailableError,
  type ProviderModelRecord,
  type ProviderResolver,
  type ProviderScope,
  type ResolvedProvider,
} from '../core/ports/provider.ts'
import type { ChannelConfig, Config } from '../config.ts'

interface CachedCatalog {
  models: ProviderModelRecord[]
  fetchedAt: number
}

const CATALOG_TTL_MS = 10 * 60_000

/** Exported for the provider test/discover routes, which need the same key order. */
export function readChannelKey(channel: ChannelConfig): string {
  if (channel.apiKeyEnv) {
    const fromEnv = process.env[channel.apiKeyEnv]
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  }
  if (channel.apiKey && channel.apiKey.trim()) return channel.apiKey.trim()
  return ''
}

function explicitCatalog(channel: ChannelConfig): ProviderModelRecord[] {
  return (channel.models ?? []).map((modelId) => {
    const [detected] = normalizeDetectedModels([{ id: modelId, label: modelId }])
    // `normalizeDetectedModels` only name-classifies. A channel that lists a
    // model explicitly is asserting it exists, so honour image roles even when
    // the regex misses an unusual name.
    const looksLikeImage =
      detected.capabilities.image_gen ||
      detected.capabilities.image_edit ||
      /image|imagen|flux|banana|seedream|grok-imagine|dall|qwen-image|glm-image/i.test(
        modelId,
      )
    return {
      modelId,
      label: modelId,
      capabilities: {
        ...detected.capabilities,
        image_gen: looksLikeImage,
        image_edit: looksLikeImage,
      },
      roles: detected.roles,
      isDefaultHeroImage: channel.imageModel ? channel.imageModel === modelId : undefined,
      isDefaultDetailImage: channel.imageModel ? channel.imageModel === modelId : undefined,
      isDefaultImageEdit: channel.imageModel ? channel.imageModel === modelId : undefined,
      isDefaultAnalysis: channel.textModel ? channel.textModel === modelId : undefined,
      isDefaultPlanning: channel.textModel ? channel.textModel === modelId : undefined,
    }
  })
}

export interface ProviderResolverOptions {
  config: Config
  logger?: Logger
  /** Force catalog re-discovery on the next resolve. */
  invalidate?: () => void
}

export function createProviderResolver(options: ProviderResolverOptions): ProviderResolver {
  const { config } = options
  const logger = options.logger ?? noopLogger
  const catalogs = new Map<string, CachedCatalog>()

  function activeChannels(): ChannelConfig[] {
    return (config.channels ?? []).filter(
      (channel) => !channel.disabled && !!channel.baseUrl?.trim(),
    )
  }

  async function catalogFor(channel: ChannelConfig): Promise<ProviderModelRecord[]> {
    if (channel.models?.length) return explicitCatalog(channel)

    const cached = catalogs.get(channel.id)
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.models

    const apiKey = readChannelKey(channel)
    const adapter = new OpenAICompatibleAdapter(channel.baseUrl, apiKey, logger)
    try {
      const listed = await adapter.listModels()
      const models: ProviderModelRecord[] = normalizeDetectedModels(
        listed.map((item) => ({
          id: item.id,
          label: item.label,
          type: item.type ?? undefined,
          category: item.category ?? undefined,
          modalities: item.modalities ?? undefined,
        })),
      ).map((detected) => ({
        modelId: detected.modelId,
        label: detected.label,
        capabilities: detected.capabilities,
        roles: detected.roles,
        isDefaultHeroImage: channel.imageModel
          ? channel.imageModel === detected.modelId
          : undefined,
        isDefaultDetailImage: channel.imageModel
          ? channel.imageModel === detected.modelId
          : undefined,
        isDefaultImageEdit: channel.imageModel
          ? channel.imageModel === detected.modelId
          : undefined,
        isDefaultAnalysis: channel.textModel ? channel.textModel === detected.modelId : undefined,
        isDefaultPlanning: channel.textModel ? channel.textModel === detected.modelId : undefined,
      }))
      catalogs.set(channel.id, { models, fetchedAt: Date.now() })
      logger.info('[mxpage] discovered model catalog', {
        channel: channel.id,
        count: models.length,
      })
      return models
    } catch (error) {
      logger.warn('[mxpage] model discovery failed; falling back to configured models', {
        channel: channel.id,
        error: error instanceof Error ? error.message : String(error),
      })
      // Cache the negative result briefly so a dead channel is not re-probed on
      // every single tool call.
      catalogs.set(channel.id, { models: [], fetchedAt: Date.now() - CATALOG_TTL_MS + 60_000 })
      return []
    }
  }

  return {
    async resolve(scope?: ProviderScope): Promise<ResolvedProvider> {
      const channels = activeChannels()
      if (channels.length === 0) {
        throw new ProviderUnavailableError(
          '未配置任何渠道。请在 设置 → 插件 → MxPage 中添加一个 OpenAI 兼容渠道（baseUrl + 密钥）。',
        )
      }

      const requested = scope?.channelId
        ? channels.find((channel) => channel.id === scope.channelId)
        : undefined
      const ordered = requested ? [requested] : channels

      let lastError: unknown = null
      for (const channel of ordered) {
        const apiKey = readChannelKey(channel)
        if (!apiKey) {
          lastError = new ProviderUnavailableError(
            `渠道 ${channel.id} 未配置密钥（apiKeyEnv=${channel.apiKeyEnv ?? '(未设置)'}）。`,
          )
          logger.warn('[mxpage] channel has no key, skipping', { channel: channel.id })
          continue
        }
        const models = await catalogFor(channel)
        if (models.length === 0) {
          lastError = new ProviderUnavailableError(
            `渠道 ${channel.id} 没有可用模型（GET /models 失败且未显式配置 models）。`,
          )
          continue
        }
        return {
          id: channel.id,
          label: channel.label ?? channel.id,
          baseUrl: channel.baseUrl,
          apiKey,
          models,
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new ProviderUnavailableError('所有渠道都不可用。')
    },
  }
}
