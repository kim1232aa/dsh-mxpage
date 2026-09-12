/**
 * Product analysis service — uploaded product images → structured selling-point JSON.
 *
 * Ported from upstream `lib/services/analysis-service.ts`
 * (ziguishian/MxPage, MIT, 灵矩绘境).
 *
 * Changes made during the DSH port (seams only):
 *  - `prisma.project.findUnique({ include: { assets } })` → `Repository.project.getDetail`.
 *  - `prisma.productAnalysis.upsert` → `Repository.analysis.upsert`;
 *    `prisma.project.update` → `Repository.project.update`.
 *  - `patchProjectModelSnapshot` → `Repository.project.mergeModelSnapshot`
 *    (the upstream compare-and-swap loop over `updatedAt` collapses in a
 *    single-writer host).
 *  - `getProviderAdapter()` → `host.provider.resolve(...)` plus a locally
 *    constructed `OpenAICompatibleAdapter`.
 *  - `readStorageFile` → `AssetStore.readStorageFile`.
 *  - `Prisma.JsonObject` / `Prisma.InputJsonValue` → plain
 *    `Record<string, unknown>`.
 *  - Module-level function exports → a `createAnalysisService(host, deps)`
 *    factory.
 *
 * Deliberately unchanged: the prompt builders, the model-picking ladder, the
 * error-classification strings (user-facing Chinese), `MAX_ANALYSIS_IMAGES`,
 * and the structured → text → repair fallback chain. Upstream passes **no**
 * `timeoutMs` on any of these calls, so the adapter default (60s for
 * structured/text) still applies; the 180s ceiling lives in `planner-service`.
 */

import { ZodError } from "zod";

import { OpenAICompatibleAdapter } from "../ai/adapters/openai-compatible.ts";
import type { ProviderAdapter } from "../ai/provider-client.ts";
import {
  buildProductAnalysisPrompt,
  buildProductAnalysisRepairPrompt,
} from "../ai/prompts/analysis.ts";
import { productAnalysisOutputSchema } from "../ai/schemas/product-analysis.ts";
import type { CoreHost, ResolvedProvider } from "../ports/index.ts";
import type { ProductAnalysis, ProductAsset } from "../types/domain.ts";
import { createAssetStore, type AssetStore } from "./asset-store.ts";
import { createTaskService, type TaskService } from "./task-service.ts";

const MAX_ANALYSIS_IMAGES = 10;

type ProviderModel = ResolvedProvider["models"][number];

function normalizeModelId(value: string) {
  return value.toLowerCase();
}

function hasCapability(model: { capabilities: unknown }, key: string) {
  const capabilities = (model.capabilities ?? {}) as Record<string, boolean>;
  return Boolean(capabilities[key]);
}

function isPreviewLike(modelId: string) {
  return /(preview|experimental|beta|test)/i.test(modelId);
}

function isLiteLike(modelId: string) {
  return /(lite|flash-lite)/i.test(modelId);
}

function isImageSpecialized(modelId: string) {
  return /(image|imagen|recraft|flux|canvas)/i.test(modelId);
}

function isStableAnalysisCandidate(modelId: string) {
  return !isPreviewLike(modelId) && !isLiteLike(modelId) && !isImageSpecialized(modelId);
}

function extractJsonBlock(raw: string) {
  const direct = raw.trim();
  if (direct.startsWith("{") || direct.startsWith("[")) {
    return direct;
  }

  const fencedMatch = direct.match(/```json([\s\S]*?)```/i) || direct.match(/```([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = direct.indexOf("{");
  const lastBrace = direct.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return direct.slice(firstBrace, lastBrace + 1);
  }

  return direct;
}

function shouldAttemptRepair(error: unknown) {
  return (
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    (error instanceof Error && /json|schema|parse/i.test(error.message))
  );
}

function pickAnalysisModel(provider: ResolvedProvider, preferredModelId?: string | null) {
  if (preferredModelId) {
    const preferred = provider.models.find((item) => item.modelId === preferredModelId);
    if (preferred && hasCapability(preferred, "text")) {
      return preferred.modelId;
    }
  }

  const textVisionModels = provider.models.filter(
    (item) => hasCapability(item, "text") && hasCapability(item, "vision"),
  );
  const textModels = provider.models.filter((item) => hasCapability(item, "text"));

  // `unknown` rather than `boolean`: upstream's `isDefaultAnalysis` was a
  // non-nullable Prisma column, while the port's `ProviderModelRecord` marks it
  // optional (`boolean | undefined` from the `&&` call sites below).
  const findMatch = (
    models: ProviderModel[],
    predicate: (model: ProviderModel) => unknown,
  ) => models.find(predicate)?.modelId;

  return (
    findMatch(
      textVisionModels,
      (item) => item.isDefaultAnalysis && isStableAnalysisCandidate(item.modelId),
    ) ??
    findMatch(
      textVisionModels,
      (item) => normalizeModelId(item.modelId).includes("gemini") && isStableAnalysisCandidate(item.modelId),
    ) ??
    findMatch(
      textVisionModels,
      (item) => normalizeModelId(item.modelId).includes("gpt-4o") && isStableAnalysisCandidate(item.modelId),
    ) ??
    findMatch(textVisionModels, (item) => isStableAnalysisCandidate(item.modelId)) ??
    findMatch(textModels, (item) => item.isDefaultAnalysis) ??
    findMatch(textModels, (item) => isStableAnalysisCandidate(item.modelId)) ??
    textModels[0]?.modelId ??
    null
  );
}

function normalizeAnalysisProviderError(error: unknown): never {
  const detail = error instanceof Error ? error.message : "Unknown analysis error";

  if (/monthly spending limit|spending limit|billing|quota|insufficient_quota/i.test(detail)) {
    throw new Error("当前 API Key 的分析额度已用尽。请前往代理商控制台提高或移除月度限额，或更换可用的 API Key。");
  }

  if (/429|rate limit|限流/i.test(detail)) {
    throw new Error("当前分析请求触发了限流。请稍后重试，或降低调用频率。");
  }

  if (/invalid token|unauthorized|forbidden/i.test(detail)) {
    throw new Error("当前 Provider 鉴权失败。请检查 baseURL、API Key 或代理商权限配置。");
  }

  if (/timed out|aborterror|network error|fetch failed/i.test(detail)) {
    throw new Error("当前 Provider 请求超时或网络异常，请稍后重试。");
  }

  throw error instanceof Error ? error : new Error(detail);
}

export interface AnalysisService {
  analyzeProject(projectId: string, preferredModelId?: string | null): Promise<ProductAnalysis>;
  updateAnalysis(projectId: string, normalizedResult: unknown): Promise<ProductAnalysis>;
}

export interface AnalysisServiceDeps {
  /** Defaults to `createTaskService(host)`. */
  taskService?: TaskService;
  /** Defaults to `createAssetStore(host)`. */
  assetStore?: AssetStore;
}

export function createAnalysisService(
  host: CoreHost,
  deps: AnalysisServiceDeps = {},
): AnalysisService {
  const { repository } = host;
  const taskService = deps.taskService ?? createTaskService(host);
  const assetStore = deps.assetStore ?? createAssetStore(host);

  async function assetToDataUrl(asset: Pick<ProductAsset, "filePath" | "mimeType">) {
    const buffer = await assetStore.readStorageFile(asset.filePath);
    const mimeType = asset.mimeType ?? "image/png";
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  }

  async function repairAnalysisOutput(input: {
    adapter: ProviderAdapter;
    model: string;
    raw: string;
  }) {
    const repaired = await input.adapter.generateText({
      model: input.model,
      systemPrompt: "Return one strict JSON object only.",
      userPrompt: buildProductAnalysisRepairPrompt(input.raw),
      monitor: {
        operation: "analysis_output_repair",
      },
    });

    const parsed = productAnalysisOutputSchema.parse(JSON.parse(extractJsonBlock(repaired.text)));
    return {
      parsed,
      repairedRaw: repaired.text,
    };
  }

  async function analyzeProject(projectId: string, preferredModelId?: string | null) {
    const project = await repository.project.getDetail(projectId);

    if (!project) {
      throw new Error("Project not found.");
    }

    const resolved = await host.provider.resolve({ projectId, operation: "project_analysis" });
    const adapter = new OpenAICompatibleAdapter(resolved.baseUrl, resolved.apiKey, host.logger);
    const model = pickAnalysisModel(resolved, preferredModelId);

    if (!model) {
      throw new Error("No analysis model available.");
    }

    const existingTask = await taskService.findRecentRunningTask({
      projectId,
      taskType: "ANALYZE",
      maxAgeMinutes: 10,
    });
    if (existingTask) {
      throw new Error("当前商品分析仍在进行中，请等待这一轮完成后再试。");
    }

    const task = await taskService.createTask({
      projectId,
      taskType: "ANALYZE",
      inputPayload: { model },
    });

    try {
      // Upstream read the `assets` relation ordered by `sortOrder`; the port's
      // read carries no ordering contract, so order a copy here. The slice must
      // happen before `buildProductAnalysisPrompt` (it sorts its input in place).
      const assets = [...project.assets].sort((a, b) => a.sortOrder - b.sortOrder);
      const imageUrls = await Promise.all(
        assets.slice(0, MAX_ANALYSIS_IMAGES).map((asset) => assetToDataUrl(asset)),
      );
      const prompt = buildProductAnalysisPrompt(assets);

      let parsedResult: Record<string, unknown>;
      let rawResult: Record<string, unknown>;

      try {
        const structured = await adapter.generateStructured({
          model,
          systemPrompt: "Return one strict JSON object only. No markdown.",
          userPrompt: prompt,
          schema: productAnalysisOutputSchema,
          images: imageUrls,
          monitor: {
            projectId,
            operation: "project_analysis",
          },
        });

        parsedResult = structured.parsed as Record<string, unknown>;
        rawResult = {
          mode: "structured",
          model,
          raw: structured.raw,
        };
      } catch (error) {
        if (!shouldAttemptRepair(error)) {
          normalizeAnalysisProviderError(error);
        }

        const fallbackText = await adapter.generateText({
          model,
          systemPrompt: "Return one strict JSON object only. No markdown.",
          userPrompt: prompt,
          images: imageUrls,
          monitor: {
            projectId,
            operation: "project_analysis_fallback",
          },
        });

        try {
          const directParsed = productAnalysisOutputSchema.parse(
            JSON.parse(extractJsonBlock(fallbackText.text)),
          );
          parsedResult = directParsed as Record<string, unknown>;
          rawResult = {
            mode: "text_fallback",
            model,
            initialError:
              error instanceof ZodError
                ? error.flatten()
                : error instanceof Error
                  ? error.message
                  : "Unknown analysis error",
            fallbackRaw: fallbackText.text,
          };
        } catch {
          const repaired = await repairAnalysisOutput({
            adapter,
            model,
            raw: fallbackText.text,
          }).catch((repairError) => {
            normalizeAnalysisProviderError(repairError);
          });

          parsedResult = repaired.parsed as Record<string, unknown>;
          rawResult = {
            mode: "text_repair",
            model,
            initialError:
              error instanceof ZodError
                ? error.flatten()
                : error instanceof Error
                  ? error.message
                  : "Unknown analysis error",
            fallbackRaw: fallbackText.text,
            repairedRaw: repaired.repairedRaw,
          };
        }
      }

      const saved = await repository.analysis.upsert(projectId, {
        rawResult,
        normalizedResult: parsedResult,
      });

      await repository.project.update(projectId, {
        status: "ANALYZED",
      });
      // Upstream wrote `providerConfigId: provider.id`; the port's resolver may
      // omit the id, and `mergeModelSnapshot` shallow-merges what it is given.
      await repository.project.mergeModelSnapshot(projectId, {
        analysisModelId: model,
        ...(resolved.id ? { providerConfigId: resolved.id } : {}),
      });

      await taskService.completeTask(task.id, saved.normalizedResult);
      return saved;
    } catch (error) {
      await taskService.failTask(
        task.id,
        error instanceof Error ? error.message : "Analysis failed",
      );
      throw error;
    }
  }

  async function updateAnalysis(projectId: string, normalizedResult: unknown) {
    // Upstream's `update` branch left `rawResult` (the model's raw output)
    // untouched while `create` set both fields. `analysis.upsert` always writes
    // both, so the existing raw value is carried forward explicitly.
    const existing = await repository.analysis.get(projectId);
    return repository.analysis.upsert(projectId, {
      rawResult: existing ? existing.rawResult : normalizedResult,
      normalizedResult,
    });
  }

  return {
    analyzeProject,
    updateAnalysis,
  };
}
