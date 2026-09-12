/**
 * Xiaohongshu (小红书) carousel workflow: plan → generate → edit.
 *
 * Ported from upstream `lib/services/xiaohongshu-service.ts`
 * (ziguishian/MxPage, MIT, 灵矩绘境).
 *
 * Database / filesystem footprint: NONE. This module imports no repository and
 * no storage driver, and it never writes a row or a file. Upstream was the
 * same: the XHS API routes only returned JSON, and the *browser* persisted the
 * flow in `localStorage["mxpage:xiaohongshu-flow:v1"]` plus IndexedDB
 * `mxpage:xiaohongshu-assets:v1`. Every generated image crosses the seam
 * inline as a `data:image/png;base64,...` URL (see `imageResultToUrl`), so a
 * headless host that wants XHS output on disk must persist
 * `XiaohongshuPageImage.imageUrl` / `XiaohongshuEditedImage.imageUrl` itself.
 *
 * Changes made during the DSH port:
 *  - `getProviderAdapter()` (Prisma `ProviderConfig` + `ModelProfile` read,
 *    plus a per-request API key carried through AsyncLocalStorage that *threw*
 *    without it) → `await host.provider.resolve({ operation })` +
 *    `new OpenAICompatibleAdapter(baseUrl, apiKey, host.logger)`. One resolve
 *    per entry point, reused for the Visual Prompt Agent and the image call,
 *    exactly as upstream resolved the adapter once per request; only `models`
 *    is handed on to the agent (same convention as `generation-service.ts`).
 *  - The three exported functions became methods of a factory-created service.
 *  - Optional `signal` on the option objects (upstream had no per-call abort)
 *    and injectable `deps.buildVisualPrompt` / `deps.createAdapter` /
 *    `deps.now` seams. Every default reproduces upstream behaviour exactly.
 *  - `buildFallbackXiaohongshuPlan` is exported (upstream kept it private) so a
 *    host can produce the offline plan with zero provider calls.
 *  - The `(item.capabilities as Record<string, boolean>).x` casts became the
 *    `readCapabilities()` helper: same access, but it no longer throws when a
 *    host model record arrives with `capabilities: undefined`.
 *
 * Everything else — every Chinese string, the planning model-picking order,
 * the fully local fallback plan and its eight page archetypes, the per-model
 * retry chain — is unchanged.
 */

import type { CoreHost } from "../ports/index.ts";
import type {
  ProviderModelRecord,
  ProviderScope,
  ResolvedProvider,
} from "../ports/provider.ts";

import type { ImageGenerationResult, ProviderAdapter } from "../ai/provider-client.ts";
import { OpenAICompatibleAdapter } from "../ai/adapters/openai-compatible.ts";
import { xiaohongshuPlanSchema, type XiaohongshuPlan } from "../ai/schemas/xiaohongshu.ts";
import { buildVisualPromptWithAgent } from "./visual-prompt-agent.ts";

export type XiaohongshuImageAspectRatio = "1:1" | "3:4" | "9:16";

export type XiaohongshuPlanInput = {
  topic: string;
  images?: string[];
  imageCount?: number;
  imageAspectRatio?: XiaohongshuImageAspectRatio;
  /** DSH port addition; upstream had no per-call abort on this path. */
  signal?: AbortSignal;
};

export type GenerateXiaohongshuOptions = {
  imageAspectRatio?: XiaohongshuImageAspectRatio;
  pageNumber?: number;
  /** DSH port addition; upstream had no per-call abort on this path. */
  signal?: AbortSignal;
};

export type EditXiaohongshuOptions = {
  imageAspectRatio?: XiaohongshuImageAspectRatio;
  /** DSH port addition; upstream had no per-call abort on this path. */
  signal?: AbortSignal;
};

export type EditXiaohongshuImageInput = {
  imageUrl: string;
  prompt: string;
  page?: XiaohongshuPlan["pages"][number] | null;
} & EditXiaohongshuOptions;

/**
 * One generated carousel page. `imageUrl` is a base64 data URL whenever the
 * image model answered with `b64_json` — the only shape the upstream browser
 * client could persist — and the provider's own URL otherwise.
 */
export interface XiaohongshuPageImage {
  pageNumber: number;
  title: string;
  prompt: string;
  model: string;
  imageUrl: string;
  revisedPrompt: string;
  updatedAt: string;
}

export interface XiaohongshuEditedImage {
  imageUrl: string;
  model: string;
  revisedPrompt: string;
  updatedAt: string;
}

/**
 * The only slice of the resolved provider this service ever reads. Narrowed on
 * purpose so `apiKey` never travels past `resolveProviderAdapter`.
 */
type ProviderModels = Pick<ResolvedProvider, "models">;

const defaultImageAspectRatio: XiaohongshuImageAspectRatio = "3:4";

function normalizeImageCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(8, Math.max(3, Math.round(count))) : 5;
}

function normalizeAspectRatio(value: unknown): XiaohongshuImageAspectRatio {
  return value === "1:1" || value === "3:4" || value === "9:16" ? value : defaultImageAspectRatio;
}

function buildXiaohongshuPrompt(input: XiaohongshuPlanInput) {
  const imageCount = normalizeImageCount(input.imageCount);
  const imageAspectRatio = normalizeAspectRatio(input.imageAspectRatio);

  return [
    `Return strict JSON only. Plan a ${imageCount}-page Xiaohongshu carousel in Simplified Chinese.`,
    "",
    "JSON shape:",
    "{ topic, audience, coreInsight, titleOptions, coverTitle, coverSubtitle, pages, caption, hashtags, exportNote }",
    `pages must contain exactly ${imageCount} items. Each page must include pageNumber, title, subtitle, body, visualDirection, layout, imagePrompt, negativePrompt.`,
    `The target image aspect ratio is ${imageAspectRatio}; every visualDirection, layout and imagePrompt must be designed for this ratio.`,
    "Each page must have a distinct visual role. Do not repeat the same imagePrompt across pages.",
    "imagePrompt should be detailed enough for later user editing: include subject, composition, scene, typography, colors, lighting and constraints in 220-450 Chinese characters.",
    "Mention concrete visual composition: subject, background, text position, color mood, props and safe margins.",
    "Add product/topic-specific physical constraints: correct airflow direction, cable routes, gravity, hinges, openings, liquid/light direction, support surfaces and contact shadows.",
    "Avoid medical/legal/financial guaranteed claims.",
    input.images?.length
      ? "Reference images are attached. Use them only to understand product/object/style and constraints."
      : "No reference image was uploaded.",
    "",
    `Topic: ${input.topic}`,
  ].join("\n");
}

function makeFallbackPage(index: number, topic: string, imageAspectRatio: XiaohongshuImageAspectRatio) {
  const templates = [
    {
      title: `${topic}，先看这一页`,
      subtitle: "封面钩子",
      body: "用一句强钩子说明这组图文能解决什么问题，让用户愿意继续滑动。",
      visualDirection: "主视觉封面，主体居中偏上，标题大而清晰，背景干净有质感。",
      layout: "顶部大标题，中部主体视觉，底部一句价值承诺。",
    },
    {
      title: "为什么你会遇到这个问题",
      subtitle: "痛点拆解",
      body: "点出用户常见误区和真实使用场景，建立共鸣。",
      visualDirection: "左右或上下对比画面，展示错误做法与正确方向，信息分区清楚。",
      layout: "上方标题，中部对比模块，下方短要点。",
    },
    {
      title: "核心方法拆成 3 步",
      subtitle: "实操方法",
      body: "把最重要的判断标准拆成 2-3 个短要点，方便收藏照做。",
      visualDirection: "步骤卡片式构图，使用数字标签和清晰图标感元素。",
      layout: "上标题，中部三步卡片，底部提醒。",
    },
    {
      title: "这样做更容易出效果",
      subtitle: "场景示范",
      body: "给出可以直接照着做的画面、动作或使用场景。",
      visualDirection: "真实生活场景示范，主体明确，背景辅助氛围但不抢焦点。",
      layout: "大图场景加浮层要点，保留足够留白。",
    },
    {
      title: "最后记住这几点",
      subtitle: "总结收藏",
      body: "收束为清晰结论，引导收藏、评论或行动。",
      visualDirection: "总结清单页，温和 CTA，整体干净适合收藏。",
      layout: "标题、清单、底部 CTA 三段式。",
    },
    {
      title: "细节别踩坑",
      subtitle: "避坑提醒",
      body: "列出最容易被忽略的 2-3 个细节，提醒用户检查。",
      visualDirection: "检查清单画面，重点错误项用轻量标记突出，不制造焦虑。",
      layout: "左侧视觉示意，右侧短句清单。",
    },
    {
      title: "适合谁，不适合谁",
      subtitle: "选择判断",
      body: "帮助用户判断自己是否适合这个方案，降低决策成本。",
      visualDirection: "人群/场景分栏图，表达适用边界，信息清晰不拥挤。",
      layout: "两栏判断卡片，底部一句建议。",
    },
    {
      title: "一页保存版",
      subtitle: "快速复盘",
      body: "把整组选题浓缩成一页保存清单，方便用户回看。",
      visualDirection: "保存版信息图，层级明确，重点句突出，背景简洁。",
      layout: "中心清单，周围少量辅助图形，底部收藏提示。",
    },
  ];
  const template = templates[index] ?? templates[templates.length - 1];

  return {
    pageNumber: index + 1,
    title: template.title,
    subtitle: template.subtitle,
    body: template.body,
    visualDirection: `${imageAspectRatio} 小红书图文页。${template.visualDirection}`,
    layout: template.layout,
    imagePrompt: "",
    negativePrompt: "不要乱码，不要文字拥挤，不要主体变形，不要违反真实物理规律的画面。",
  };
}

/**
 * The offline path: a complete, publishable plan built with zero provider
 * calls. Exported (upstream kept it module-private) so a host can offer
 * "plan without a key" explicitly instead of waiting for a timeout.
 */
export function buildFallbackXiaohongshuPlan(
  topic: string,
  imageCount = 5,
  imageAspectRatio: XiaohongshuImageAspectRatio = defaultImageAspectRatio,
): XiaohongshuPlan {
  const normalizedCount = normalizeImageCount(imageCount);
  return normalizeXiaohongshuPlan(
    {
      topic,
      audience: "对该选题感兴趣、希望快速获得实用建议的小红书用户",
      coreInsight: "用户需要一套清晰、可收藏、能快速照着执行的图文内容。",
      titleOptions: [`${topic}，这篇讲清楚`, `${topic}实用指南`, `别再乱做${topic}`],
      coverTitle: `${topic}，这篇讲清楚`,
      coverSubtitle: "一组可直接发布的小红书图文思路",
      pages: Array.from({ length: normalizedCount }, (_, index) =>
        makeFallbackPage(index, topic, imageAspectRatio),
      ),
      caption: `${topic}\n\n整理了一组可以直接参考的小红书图文思路，适合收藏后慢慢看。`,
      hashtags: ["#小红书图文", "#实用干货", "#内容规划", "#图文设计", "#AI创作"],
      exportNote: "Provider 超时或返回不稳定时自动生成的本地兜底规划。",
    },
    topic,
    normalizedCount,
    imageAspectRatio,
  );
}

function shouldUseLocalFallback(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /timed out|timeout|aborterror|network error|fetch failed|structured parse|invalid json/i.test(error.message);
}

function normalizeXiaohongshuPlan(
  plan: XiaohongshuPlan,
  topic: string,
  imageCount = 5,
  imageAspectRatio: XiaohongshuImageAspectRatio = defaultImageAspectRatio,
): XiaohongshuPlan {
  const targetCount = normalizeImageCount(imageCount);
  const normalizedTopic = plan.topic.trim() || topic;
  const sourcePages = Array.isArray(plan.pages) ? plan.pages.slice(0, targetCount) : [];

  while (sourcePages.length < targetCount) {
    sourcePages.push(makeFallbackPage(sourcePages.length, normalizedTopic, imageAspectRatio));
  }

  const pages = sourcePages.map((page, index) => {
    const fallback = makeFallbackPage(index, normalizedTopic, imageAspectRatio);
    const title = page.title.trim() || fallback.title;
    const body = page.body.trim() || fallback.body;
    const visualDirection =
      page.visualDirection.trim() ||
      `${imageAspectRatio} 小红书图文页，主体清晰，中文标题居上，内容分区明确，留白充足。`;
    const layout = page.layout.trim() || fallback.layout;
    const negativePrompt =
      page.negativePrompt.trim() || "不要乱码、不要文字拥挤、不要不符合真实物理逻辑的画面。";

    return {
      ...page,
      pageNumber: index + 1,
      title,
      subtitle: page.subtitle.trim(),
      body,
      visualDirection,
      layout,
      negativePrompt,
      imagePrompt:
        page.imagePrompt.trim() ||
        [
          `小红书 ${imageAspectRatio} 图文第 ${index + 1} 页。`,
          `主题：${normalizedTopic}`,
          `标题：${title}`,
          page.subtitle ? `副标题：${page.subtitle}` : "",
          `正文要点：${body}`,
          `画面描述：${visualDirection}`,
          `版式：${layout}`,
          `避免：${negativePrompt}`,
        ]
          .filter(Boolean)
          .join("\n"),
    };
  });

  const titleOptions = plan.titleOptions.map((item) => item.trim()).filter(Boolean).slice(0, 8);
  while (titleOptions.length < 3) {
    titleOptions.push(`${normalizedTopic}，这篇讲清楚`, `${normalizedTopic}实用指南`, `别再乱做${normalizedTopic}`);
  }

  const hashtags = plan.hashtags.map((item) => item.trim()).filter(Boolean).slice(0, 12);
  while (hashtags.length < 5) {
    hashtags.push("#小红书图文", "#实用干货", "#内容规划", "#图文设计", "#AI创作");
  }

  return {
    ...plan,
    topic: normalizedTopic,
    audience: plan.audience.trim() || "对该选题感兴趣、希望快速获得实用建议的小红书用户",
    coreInsight: plan.coreInsight.trim() || "用户需要一套清晰、可执行、容易收藏的图文内容。",
    coverTitle: plan.coverTitle.trim() || titleOptions[0] || normalizedTopic,
    coverSubtitle: plan.coverSubtitle.trim(),
    titleOptions: [...new Set(titleOptions)].slice(0, 8),
    pages,
    caption: plan.caption.trim() || `${normalizedTopic}\n\n整理了一组可以直接参考的小红书图文思路，适合收藏后慢慢看。`,
    hashtags: [...new Set(hashtags)].slice(0, 12),
    exportNote: plan.exportNote.trim(),
  };
}

/**
 * THE data-URL producer of this service. A provider that answers with
 * `b64_json` yields an inline `data:image/png;base64,...` payload (the MIME is
 * hardcoded upstream — a provider returning JPEG bytes still gets labelled
 * PNG); otherwise the provider's own URL is passed through untouched. Throws
 * when neither is present, which is what the callers' per-model retry chain
 * catches.
 */
function imageResultToUrl(result: ImageGenerationResult) {
  if (result.b64Json) {
    return `data:image/png;base64,${result.b64Json}`;
  }

  if (result.url) {
    return result.url;
  }

  throw new Error("图像模型没有返回可用图片。");
}

function unique(values: Array<string | null | undefined>) {
  return values.filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
}

function readCapabilities(model: ProviderModelRecord): Record<string, boolean> {
  return (model.capabilities ?? {}) as Record<string, boolean>;
}

function getImageGenerationModels(provider: ProviderModels) {
  return unique([
    provider.models.find((item) => item.isDefaultHeroImage)?.modelId,
    provider.models.find((item) => item.isDefaultDetailImage)?.modelId,
    provider.models.find((item) => readCapabilities(item).image_gen)?.modelId,
  ]);
}

function getImageEditModels(provider: ProviderModels) {
  return unique([
    provider.models.find((item) => item.isDefaultImageEdit)?.modelId,
    provider.models.find((item) => readCapabilities(item).image_edit)?.modelId,
    provider.models.find((item) => item.isDefaultHeroImage)?.modelId,
  ]);
}

function buildPageImagePrompt(
  plan: XiaohongshuPlan,
  page: XiaohongshuPlan["pages"][number],
  imageAspectRatio: XiaohongshuImageAspectRatio,
) {
  const basePrompt =
    page.imagePrompt.trim() ||
    [
      `小红书 ${imageAspectRatio} 图文第 ${page.pageNumber} 页。`,
      `页面标题：${page.title}`,
      page.subtitle ? `副标题：${page.subtitle}` : "",
      `正文要点：${page.body}`,
      `画面描述：${page.visualDirection}`,
      `版式：${page.layout}`,
      page.negativePrompt ? `禁止：${page.negativePrompt}` : "",
    ]
      .filter(Boolean)
      .join("\n");

  return [
    basePrompt,
    "",
    `生成一张适合小红书图文轮播的 ${imageAspectRatio} 图片。`,
    "图内必须包含中文标题、核心短句和必要的信息层级，文字要清晰，不要乱码，不要挤压。",
    "整体要像真实可发布的小红书图文页，而不是网页截图或空白海报。",
    `整组内容主题：${plan.topic}`,
    `目标人群：${plan.audience}`,
    `核心洞察：${plan.coreInsight}`,
  ].join("\n");
}

async function runImageModel<T>(
  models: string[],
  runner: (model: string) => Promise<T>,
  emptyMessage: string,
) {
  const errors: string[] = [];

  for (const model of models) {
    try {
      return { model, result: await runner(model) };
    } catch (error) {
      errors.push(`${model}: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  throw new Error(models.length === 0 ? emptyMessage : errors.join(" | "));
}

export interface XiaohongshuServiceDeps {
  /** Visual Prompt Agent seam. Defaults to the ported `buildVisualPromptWithAgent`. */
  buildVisualPrompt?: typeof buildVisualPromptWithAgent;
  /**
   * Adapter seam. Defaults to
   * `new OpenAICompatibleAdapter(resolved.baseUrl, resolved.apiKey, host.logger)`.
   */
  createAdapter?: (resolved: ResolvedProvider) => ProviderAdapter;
  /** Clock seam for `updatedAt`. Defaults to `new Date()`. */
  now?: () => Date;
}

export interface XiaohongshuService {
  planXiaohongshuPost(input: XiaohongshuPlanInput): Promise<XiaohongshuPlan>;
  generateXiaohongshuImages(
    plan: XiaohongshuPlan,
    referenceImages?: string[],
    options?: GenerateXiaohongshuOptions,
  ): Promise<XiaohongshuPageImage[]>;
  editXiaohongshuImage(input: EditXiaohongshuImageInput): Promise<XiaohongshuEditedImage>;
}

/**
 * Xiaohongshu service factory. Uses only `host.provider` (and `host.logger` for
 * adapter usage events) — `host.repository` and `host.storage` are deliberately
 * untouched, because nothing on this path is persisted server-side.
 */
export function createXiaohongshuService(
  host: CoreHost,
  deps: XiaohongshuServiceDeps = {},
): XiaohongshuService {
  const buildVisualPrompt = deps.buildVisualPrompt ?? buildVisualPromptWithAgent;
  // Annotated on purpose: without it the inferred type is the union
  // `((r) => OpenAICompatibleAdapter) | ((r) => ProviderAdapter)`, and calling a
  // method through that union is needlessly fragile.
  const createAdapter: (resolved: ResolvedProvider) => ProviderAdapter =
    deps.createAdapter ??
    ((resolved: ResolvedProvider) =>
      new OpenAICompatibleAdapter(resolved.baseUrl, resolved.apiKey, host.logger));
  const now = deps.now ?? (() => new Date());

  /**
   * Upstream's `getProviderAdapter()`: one resolution per entry point, reused
   * for the Visual Prompt Agent and the image call. Only `models` is handed on.
   */
  async function resolveProviderAdapter(scope: ProviderScope) {
    const resolved = await host.provider.resolve(scope);
    const provider: ProviderModels = { models: resolved.models };
    return { provider, adapter: createAdapter(resolved) };
  }

  async function planXiaohongshuPost(input: XiaohongshuPlanInput): Promise<XiaohongshuPlan> {
    const topic = input.topic.trim();
    if (!topic) {
      throw new Error("请输入小红书图文选题。");
    }

    const imageCount = normalizeImageCount(input.imageCount);
    const imageAspectRatio = normalizeAspectRatio(input.imageAspectRatio);
    const { provider, adapter } = await resolveProviderAdapter({ operation: "xiaohongshu_planning" });
    const model =
      provider.models.find((item) => item.isDefaultPlanning)?.modelId ??
      provider.models.find((item) => readCapabilities(item).structured_output)?.modelId ??
      provider.models.find((item) => readCapabilities(item).text)?.modelId;

    if (!model) {
      throw new Error("当前没有可用的小红书图文规划模型。");
    }

    try {
      const result = await adapter.generateStructured({
        model,
        systemPrompt: "Return strict JSON only.",
        userPrompt: buildXiaohongshuPrompt({ ...input, topic, imageCount, imageAspectRatio }),
        images: input.images?.slice(0, 2),
        schema: xiaohongshuPlanSchema,
        timeoutMs: 45000,
        monitor: {
          operation: "xiaohongshu_planning",
        },
        signal: input.signal,
      });

      return normalizeXiaohongshuPlan(result.parsed, topic, imageCount, imageAspectRatio);
    } catch (error) {
      if (shouldUseLocalFallback(error)) {
        return buildFallbackXiaohongshuPlan(topic, imageCount, imageAspectRatio);
      }
      throw error;
    }
  }

  async function generateXiaohongshuImages(
    plan: XiaohongshuPlan,
    referenceImages: string[] = [],
    options: GenerateXiaohongshuOptions = {},
  ): Promise<XiaohongshuPageImage[]> {
    const imageAspectRatio = normalizeAspectRatio(options.imageAspectRatio);
    const { provider, adapter } = await resolveProviderAdapter({ operation: "xiaohongshu_image_generate" });
    const models = getImageGenerationModels(provider);
    const pages =
      typeof options.pageNumber === "number"
        ? plan.pages.filter((page) => page.pageNumber === options.pageNumber)
        : plan.pages;

    if (pages.length === 0) {
      throw new Error("没有找到要生成的小红书页面。");
    }

    const images: XiaohongshuPageImage[] = [];
    for (const page of pages) {
      const basePrompt = buildPageImagePrompt(plan, page, imageAspectRatio);
      const prompt = await buildVisualPrompt({
        provider,
        adapter,
        mode: "xiaohongshu_page",
        title: page.title,
        goal: `为小红书选题“${plan.topic}”生成第 ${page.pageNumber} 页图文。`,
        copy: [page.subtitle, page.body, `整组洞察：${plan.coreInsight}`].filter(Boolean).join("\n"),
        basePrompt,
        aspectRatio: imageAspectRatio,
        contentLanguage: "zh-CN",
        referenceImages,
        productContext: {
          topic: plan.topic,
          audience: plan.audience,
          coreInsight: plan.coreInsight,
          coverTitle: plan.coverTitle,
          caption: plan.caption,
          hashtags: plan.hashtags,
          currentPage: page,
          imageAspectRatio,
        },
        operation: "xiaohongshu_visual_prompt_agent_generate",
        signal: options.signal,
      });
      const generated = await runImageModel(
        models,
        (model) =>
          adapter.generateImage({
            model,
            prompt,
            aspectRatio: imageAspectRatio,
            referenceImages,
            timeoutMs: 120000,
            monitor: {
              operation: "xiaohongshu_image_generate",
            },
            signal: options.signal,
          }),
        "当前没有可用的小红书图像生成模型。",
      );

      images.push({
        pageNumber: page.pageNumber,
        title: page.title,
        prompt,
        model: generated.model,
        imageUrl: imageResultToUrl(generated.result),
        revisedPrompt: generated.result.revisedPrompt ?? "",
        updatedAt: now().toISOString(),
      });
    }

    return images;
  }

  async function editXiaohongshuImage(input: EditXiaohongshuImageInput): Promise<XiaohongshuEditedImage> {
    const imageAspectRatio = normalizeAspectRatio(input.imageAspectRatio);
    const { provider, adapter } = await resolveProviderAdapter({ operation: "xiaohongshu_image_edit" });
    const models = getImageEditModels(provider);
    const basePrompt = [
      input.prompt,
      "",
      input.page ? `当前页标题：${input.page.title}` : "",
      input.page ? `当前页正文：${input.page.body}` : "",
      `保留原图的小红书 ${imageAspectRatio} 图文风格和主体结构，只修改用户指出的问题。`,
      "中文文字必须清晰，不要产生乱码，不要把文字压到边缘。",
    ]
      .filter(Boolean)
      .join("\n");
    const prompt = await buildVisualPrompt({
      provider,
      adapter,
      mode: "image_edit",
      title: input.page?.title ?? "小红书图文单页修改",
      goal: "按用户修改意见精修当前小红书图文页，保留原图主体和整体风格。",
      copy: input.page?.body ?? "",
      basePrompt,
      aspectRatio: imageAspectRatio,
      contentLanguage: "zh-CN",
      referenceImages: [input.imageUrl],
      productContext: {
        page: input.page ?? null,
        userEditInstruction: input.prompt,
        imageAspectRatio,
      },
      operation: "xiaohongshu_visual_prompt_agent_edit",
      signal: input.signal,
    });

    const edited = await runImageModel(
      models,
      (model) =>
        adapter.editImage({
          model,
          image: input.imageUrl,
          prompt,
          aspectRatio: imageAspectRatio,
          timeoutMs: 120000,
          monitor: {
            operation: "xiaohongshu_image_edit",
          },
          signal: input.signal,
        }),
      "当前没有可用的小红书图像编辑模型。",
    );

    return {
      imageUrl: imageResultToUrl(edited.result),
      model: edited.model,
      revisedPrompt: edited.result.revisedPrompt ?? "",
      updatedAt: now().toISOString(),
    };
  }

  return {
    planXiaohongshuPost,
    generateXiaohongshuImages,
    editXiaohongshuImage,
  };
}
