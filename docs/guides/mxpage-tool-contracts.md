# dsh-mxpage 工具契约（完整，v0.3）

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
type ContentLanguage = string   // 例：zh-CN | en-US | ja-JP | ko-KR
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

## 工具表（20 个，全部 `mxpage_*`）

### `mxpage_create_project`

| 参数 | schema | 必填 |
|------|--------|------|
| name | string | 否，默认 untitled |
| image_paths | array\<string\> | 与 attachment_ids 合计 1–10 |
| attachment_ids | array\<string\> | 对话图片附件 id（用户刚贴的图走这里） |
| platform | string | 否，`general_ecommerce\|taobao_tmall\|pinduoduo\|xiaohongshu\|douyin_ecommerce` |
| style | string | 否，`generic_clean\|premium\|soft_lifestyle\|conversion_focused\|tech` |
| language | string | 否，图内文案语言 |
| aspect_ratio | enum AspectRatio | 否，详情默认 3:4 |

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

参数：`project_id` 必填；`hero_count` 1–5 默认 3；`detail_count` 1–10 默认 6；`aspect_ratio` 可选；`language` 可选；`auto_decide_counts` 可选（交给模型定数量）；`model` 可选。  
未 `analyzed`（或重规划时的 `planned`）一律 `{ ok: false, error: 'MXPAGE_STATE' }`。  
成功：`{ ok: true, visualStyleGuide, sections[], previewConfig }`。写 `plan.json`、`style-guide.json`。  
**重新规划会删除现有全部分镜、版本与已生成图片**，面板层面有显式确认。

### `mxpage_generate_section`

参数：`project_id`、`section_key` 必填；`prompt_override` 可选；`size` `1024x1024\|1024x1536`；`model` 可选。  
`timeoutMs: 180_000`。`isConcurrencySafe` 恒不返回 true。  
未给 `prompt_override` 时先跑 Visual Prompt Agent。默认参考：主图 + 第一张成功 hero。有参考走 `/images/edits` multipart（字段 `image`）。  
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

落盘 `output/` + `versions/<key>/vN.png`，然后 `ctx.attachments.saveImage(...)` 回会话。

### `mxpage_edit_section`

参数：`project_id`、`section_key`、`mode` 必填；`instruction` 在 repaint/enhance 必填；`target_language` 在 translate 必填。  
走 `/images/edits`，参考 = 当前成品 + 主图。新版本，不覆盖旧文件。

### `mxpage_generate_page`

参数：`project_id` 必填；`section_keys` 可选；`mode: "missing"` 只补未成功分镜。  
`exec.signal.aborted` 则 throw AbortError，不 start。  
成功立即返回 `{ kind: 'background', jobId }`。  
顺序：缺分析就分析 → 缺规划就规划 → 全部 hero → detail（参考主图 + 第一张成功 hero）。进度经 `ctx.jobs` 上报。

### `mxpage_job_status` / `mxpage_job_cancel`

参数：`job_id` 必填。  
status：`{ ok, state, progress, currentSection, error? }`（state 对齐 `JobStatus`）。  
cancel：调用 registry/job hooks，已完成分镜保留。

### `mxpage_export_page`

参数：`project_id` 必填；`format` `zip\|json` 默认 zip。  
zip 写 `output/export-<iso>.zip`，内含 `00-头图/` + `01-详情页/` + `export-manifest.json`。

### `mxpage_xiaohongshu_plan`

参数：`topic` 必填；`image_count` 3–8 默认 5；`aspect_ratio` 默认 3:4；`reference_paths` 可选。  
第 1 步：产出逐页文案 + 每页 `imagePrompt`（VPA 把关）。有完全本地化的中文兜底规划，无可用文本模型也能出稿。

### `mxpage_xiaohongshu_generate`

参数：`plan_id`（或等价规划引用）必填；`aspect_ratio` 可选。  
第 3 步：一页一图，VPA 把关。

### `mxpage_xiaohongshu_edit`

参数：页面引用 + `prompt`（要改什么）必填；`aspect_ratio` 可选。  
第 4 步：就地编辑一页，写新版本。

### `mxpage_translate_page`

| 参数 | 必填 |
|------|------|
| project_id | 是 |
| target_language | 是，例 `zh-CN / en-US / ja-JP / ko-KR` |

整页翻译后台 job：对每个 `currentImageAssetId` 非空的分镜（按 `order` 排序）做一次 `editMode: 'translate'` 编辑，全部图内文字重排为目标语言，逐镜写新版本。  
无已生成分镜 → `{ ok: false, error: 'MXPAGE_STATE' }`。单镜失败不中止整 job，记入 `logger.warn`，job 结果带 `completed / failed / total`。  
成功：`{ ok: true, kind: 'background', jobId, total }`，用 `mxpage_job_status` 轮询。

### `mxpage_update_project`

参数：`project_id` 必填；`name` / `platform` / `style` / `description` 至少给一个（全可选）。  
成功：`{ ok: true, projectId, name, platform, style, status }`。

### `mxpage_delete_project`

| 参数 | 必填 |
|------|------|
| project_id | 是 |
| confirm | **是**，必须显式 `true` |

删除项目及其工作区全部文件（上传、生成图、导出），不可恢复。  
`confirm !== true` → `{ ok: false, error: 'MXPAGE_CONFIRM' }`；缺 `confirm` 参数直接被 defineTool 校验拒绝。  
未知项目 → `MXPAGE_NOT_FOUND`。

### `mxpage_set_main_asset`

参数：`project_id` 必填；`asset_id` 与 `image_path` 二选一（都没给 → `MXPAGE_ARGS`）。  
`image_path` 按 `filePath` 或 `fileName` 匹配项目内素材；无匹配 → `MXPAGE_NOT_FOUND`。  
成功：`{ ok: true, projectId, mainAssetId }`。主图是所有生成的 hero 参考。

### `mxpage_usage_stats`

参数：`hours` 可选，回溯窗口，默认 24，clamp 到 1–720。只读。  
成功：

```ts
{
  ok: true
  hours: number
  totalRequests: number
  successRequests: number
  failedRequests: number
  chatRequests: number          // text | structured | vision
  imageRequests: number         // image_generation | image_edit
  spendingLimitedRequests: number
  rateLimitedRequests: number
  averageDurationMs: number
  topModels: { model: string; count: number }[]
  recentErrors: { at, model, status, endpoint, error }[]   // 最多 5 条
}
```

数据源：`<storeRoot>/usage.jsonl` 账本（Logger 端口 `usage(event)` 追加写入），配额分类移植自上游 `lib/monitor/api-usage.ts`。

### `mxpage_channels`

无参数。只读诊断：当前激活渠道（id / label / baseUrl）、模型目录、image_gen / image_edit / vision 能力计数、各渠道密钥在位情况。生图失败时**先跑这个**。

---

## 错误码

出现在 `{ ok: false, error }` 的 `error` 字段（稳定字符串，可附中文 `message`）：

| code | 何时 |
|------|------|
| `MXPAGE_NO_IMAGE_KEY` | 激活渠道的 `apiKeyEnv` 对应环境变量为空 |
| `MXPAGE_NO_VISION` | 当前路由无图像输入且未配文本模型 |
| `MXPAGE_STATE` | 非法状态机跳转（如未生成就整页翻译） |
| `MXPAGE_NOT_FOUND` | 未知 project / section / job / asset |
| `MXPAGE_PATH` | 路径穿越或非图片 |
| `MXPAGE_MISSING_PROMPT` | 无 override 且 VPA 失败 |
| `MXPAGE_MISSING_LANGUAGE` | translate 未给 target_language |
| `MXPAGE_CONFIRM` | 破坏性操作未显式 confirm |
| `MXPAGE_ARGS` | 二选一参数都没给 |
| `MXPAGE_HTTP_401` | 图像 API 密钥无效 |
| `MXPAGE_HTTP_429` | 额度/速率 |
| `MXPAGE_HTTP_400` | 模型不支持或请求非法 |
| `MXPAGE_CANCELLED` | 信号 abort（若走规范值而非 throw） |
| `MXPAGE_TOO_LARGE` | 图 > 20MiB 或边长 > 8192 |

消息必须经过 `redactSecrets`。不要把堆栈、Bearer、`sk-` 写进规范值。
