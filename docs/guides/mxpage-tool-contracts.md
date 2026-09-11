# dsh-mxpage 工具契约（完整）

对照：[规范调查](./dsh-plugin-spec-investigation.md) §2–4、[插件规格](../superpowers/specs/2026-09-12-dsh-mxpage-plugin-design.md)。  
实现时不得改工具名。所有 `output.schema` 的 object 都声明 `additionalProperties`。`render` 一律：

```ts
render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
```

后台 job 的成功值例外：`{ kind: 'background', jobId }`，render 为 `started background job ${jobId}`。

业务失败统一包在成功规范值里：`{ ok: false, error: string }`（见 [错误码](#错误码)）。基础设施失败才 `throw`。

---

## 公共类型

```ts
type AspectRatio = '1:1' | '3:4' | '9:16'
type ContentLanguage = 'zh-CN' | 'en' | 'ja' | 'ko'
type AssetRole = 'main' | 'angle' | 'detail' | 'reference'
type SectionType =
  | 'hero' | 'selling_points' | 'scenario' | 'detail_closeup'
  | 'specs' | 'material' | 'comparison' | 'gift_scene'
  | 'brand_trust' | 'summary' | 'custom'
type VpaMode = 'ecommerce_section' | 'xiaohongshu_page' | 'image_edit'
type EditMode = 'repaint' | 'enhance' | 'translate'
type ProjectStatus =
  | 'created' | 'analyzing' | 'analyzed'
  | 'planning' | 'planned'
  | 'generating' | 'generated'
  | 'editing' | 'failed'
```

分析 JSON（与 MxPage Zod 对齐，字段不可丢）：

```ts
interface ProductAnalysisOutput {
  productName: string
  category: string
  subcategory: string
  material: string
  color: string
  styleTags: string[]
  targetAudience: string[]
  usageScenarios: string[]
  coreSellingPoints: string[]
  differentiationPoints: string[]
  userConcerns: string[]
  recommendedFocusPoints: string[]
  additionalInformation: string
  generationRequirements: string
  suggestedSectionPlan: { type: string; title: string; goal: string }[]
}
```

VPA JSON：

```ts
interface VisualPromptOutput {
  analysisSummary: string
  finalPrompt: string          // min 20 chars
  negativePrompt: string
  qualityChecklist: string[]
}
```

---

## 工具表

### `mxpage_create_project`

| 参数 | schema | 必填 |
|------|--------|------|
| name | string | 否，默认 untitled |
| image_paths | array\<string\> | **是**，1–10 |
| main_image_path | string | 否，默认第一张 |
| language | enum ContentLanguage | 否 |
| aspect_ratio | enum AspectRatio | 否，详情默认画幅 |

成功：`{ ok: true, projectId, assetCount, mainAssetPath, workspaceDir }`  
副作用：复制（不移动）到 `assets/`，写 `project.json`，状态 `created`。

### `mxpage_add_asset`

| 参数 | 必填 |
|------|------|
| project_id | 是 |
| image_path | 与 attachment_id 二选一 |
| attachment_id | 与 image_path 二选一 |
| role | 是，`main\|angle\|detail\|reference` |

替换主图必须 `role=main`。成功：`{ ok: true, projectId, assetCount, mainAssetPath }`。

### `mxpage_project_status`

参数：`project_id` 必填。只读。  
成功：`{ ok: true, status, language, aspectRatio, mainAssetPath, assets[], sections[], job? }`。未分析也可调。

### `mxpage_analyze_product`

参数：`project_id` 必填；`model` 可选。`timeoutMs: 120_000`。需要视觉。  
成功：`{ ok: true, projectId, modelUsed, analysis: ProductAnalysisOutput }`。写 `analysis.json`，`created\|failed → analyzing → analyzed`。

### `mxpage_plan_page`

参数：`project_id` 必填；`hero_count` 1–5 默认 3；`detail_count` 1–10 默认 6；`platform` `ecommerce\|xiaohongshu`；`language` 可选。  
未 `analyzed`（或重规划时的 `planned`）一律 `{ ok: false, error: 'MXPAGE_STATE' }`。  
成功：`{ ok: true, visualStyleGuide, sections[], previewConfig }`。写 `plan.json`、`style-guide.json`。

### `mxpage_refine_prompt`

参数：`project_id`、`section_key` 必填；`mode` 默认按平台。  
成功：`{ ok: true, ...VisualPromptOutput }`。写 `prompts/<sectionKey>.json`。

### `mxpage_generate_section`

参数：`project_id`、`section_key` 必填；`prompt_override` 可选；`reference_paths` 可选；`size` `1024x1024\|1024x1536`；`model` 可选。  
`timeoutMs: 180_000`。`isConcurrencySafe` 恒不返回 true。  
无 prompt 且无 VPA 文件 → `{ ok: false, error: 'MXPAGE_MISSING_PROMPT' }`。  
默认参考：主图 + 第一张成功 hero。有参考走 `/images/edits` multipart（字段 `image`）。  
成功：

```ts
{
  ok: true
  projectId: string
  sectionKey: string
  outputPath: string
  attachmentId?: string
  modelUsed: string
  versionId: string
}
```

落盘 `output/` + `versions/<key>/vN.png`，然后：

```ts
const ref = await ctx.attachments.saveImage({
  data: pngBytes,
  mediaType: 'image/png',
  name: `${sectionKey}.png`,
})
```

### `mxpage_edit_section`

参数：`project_id`、`section_key`、`mode` 必填；`instruction` 在 repaint/enhance 必填；`target_language` 在 translate 必填。  
走 `/images/edits`，参考 = 当前成品 + 主图。新版本，不覆盖旧文件。

### `mxpage_generate_page`

参数：`project_id` 必填；`section_keys` 可选（默认未成功模块）。  
`exec.signal.aborted` 则 throw AbortError，不 start。  
成功立即：

```ts
{ kind: 'background', jobId: string }
```

`run()` 同步返回 `{ cancel, done }`；内部用自有 `AbortController`。顺序：缺分析就分析 → 缺规划就规划 → 全部 hero → detail（参考主图 + 第一张成功 hero）。进度 `tasks/<jobId>.json`。

JobKind 扩展：

```ts
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { mxpage_page: 'mxpage_page' }
}
```

### `mxpage_job_status` / `mxpage_job_cancel`

参数：`job_id` 必填。  
status：`{ ok, state, progress, currentSection, error? }`（state 对齐 `JobStatus`：running/stopping/completed/killed/failed）。  
cancel：调用 registry/job hooks，已完成 section 保留。

### `mxpage_export_page`

参数：`project_id` 必填；`format` `paths\|zip` 默认 paths。  
zip 写 `output/export-<iso>.zip`，内含各 section png + `analysis.json`。

---

## 错误码

出现在 `{ ok: false, error }` 的 `error` 字段（稳定字符串，可附中文 `message`）：

| code | 何时 |
|------|------|
| `MXPAGE_NO_IMAGE_KEY` | `process.env[imageApiKeyEnv]` 空 |
| `MXPAGE_NO_VISION` | 当前路由无图像输入且未配 textBaseUrl |
| `MXPAGE_STATE` | 非法状态机跳转 |
| `MXPAGE_NOT_FOUND` | 未知 project / section / job |
| `MXPAGE_PATH` | 路径穿越或非图片 |
| `MXPAGE_MISSING_PROMPT` | 无 override 也无 VPA 文件 |
| `MXPAGE_MISSING_LANGUAGE` | translate 未给 target_language |
| `MXPAGE_HTTP_401` | 图像 API 密钥无效 |
| `MXPAGE_HTTP_429` | 额度/速率 |
| `MXPAGE_HTTP_400` | 模型不支持或请求非法 |
| `MXPAGE_CANCELLED` | 信号 abort（若走规范值而非 throw） |
| `MXPAGE_TOO_LARGE` | 图 > 20MiB 或边长 > 8192 |

消息必须经过 `redactSecrets`。不要把堆栈、Bearer、`sk-` 写进规范值。
