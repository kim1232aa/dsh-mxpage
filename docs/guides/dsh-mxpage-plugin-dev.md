# dsh-mxpage 开发文档

> 将 [MxPage](https://github.com/ziguishian/MxPage) 的电商生图流水线做成 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 原生插件。
>
> 文档日期：2026-09-12  
> 状态：调查完成；正式规格与实现计划已拆出  
> 目标读者：插件作者、接入 DSH 的工程同学
>
> **先读这些再改本文：**
> - 需求（用户原话）：[docs/requirements.md](../requirements.md)
> - 规范调查（本机 d.ts 核实）：[dsh-plugin-spec-investigation.md](./dsh-plugin-spec-investigation.md)
> - 工具契约：[mxpage-tool-contracts.md](./mxpage-tool-contracts.md)
> - 规格：[docs/superpowers/specs/2026-09-12-dsh-mxpage-plugin-design.md](../superpowers/specs/2026-09-12-dsh-mxpage-plugin-design.md)
> - 计划：[docs/superpowers/plans/2026-09-12-dsh-mxpage-plugin.md](../superpowers/plans/2026-09-12-dsh-mxpage-plugin.md)
>
> 本文保留迁移清单与包布局。**Host API 字段名以规范调查为准**（jobs 的 `run(): JobHooks`，`saveImage({ data })`，`attachmentId`）。与 d.ts 冲突时改本文，不要改 runtime。

---

## 1. 背景、目标与非目标

### 1.1 背景

MxPage（灵矩绘境）是一套 AI 原生商品图文工作台：上传商品图 → 结构化分析 → 规划头图/详情模块 → Visual Prompt Agent 细化提示词 → 调用 OpenAI 兼容图像接口生成/编辑/翻译 → 导出整页。默认文本模型走 GPT 系列，默认图像模型走 `gpt-image-2`，支持私有化 OpenAI-compatible 网关。

DeepSeek Harness（`dsh`）是「一切皆插件」的 Agent 运行时，内核是 Cordis。模型、工具、技能、会话、沙箱、存储、循环、调度、UI 全部以插件形式挂载。对外分发单位是 **bundle**（声明 `dsh.bundle` 的 npm 包），用户通过 `dsh plugin --profile <name> add …` 装进某个 **profile**。

把 MxPage「做成 dsh」，正确含义不是把 Next.js + Electron + Prisma 整仓嵌进 Harness，而是：

1. 抽出 MxPage 真正有壁垒的 **分析 → 规划 → 提示词代理 → 分镜生成** 流水线；
2. 按 DSH 插件规范注册为 **Host 工具 + Skill + 工作区状态**；
3. 长任务走 `ctx.jobs`，成品图走 `ctx.attachments`，配置走 Schemastery。

### 1.2 目标

- 用户在 DSH 对话里说「根据这张商品图出一套淘宝详情页」，Agent 能走完整流水线并在会话中展示图片。
- 单图、整页、编辑、翻译、小红书四步、批量 SKU 均可被工具组合覆盖。
- 插件可独立发布：`dsh plugin --profile web add dsh-mxpage`。
- 仓库打 GitHub topic `dsh-plugin`，方便市场收录。

### 1.3 非目标（明确不做）

| 不做 | 原因 |
|------|------|
| 移植 Next.js App Router / Electron / Prisma | DSH 插件是 Cordis ESM 模块，不是独立 Web 应用 |
| 再做一个通用无限画布/图库 | 社区已有 `dsh-imagegen`、`dsh-image-gen`、`dsh-image-create` |
| 改 DSH 源码、写新的 LLM Adapter | 文本规划可走 `ctx.llm` 或独立 OpenAI-compatible 文本端点 |
| 把 API Key 写进浏览器或会话事件 | 凭据只存在 Host 配置 / 环境变量 |
| 在工具 `render` 里塞原始 base64 | 模型可见输出保持文本；图片先 `saveImage` 再引用 |

### 1.4 成功标准

1. 一张商品主图 + 一句自然语言需求，能产出至少 1 张头图 + 3 张详情模块图，并写入工作区。
2. 同一商品多模块之间主体一致（主图锚定 + 风格指南约束）。
3. 生图失败有可读错误（额度、端点、模型不支持、取消），不把内部堆栈暴露给模型。
4. 文本-only 路由不会因为历史里出现「未声明的 image block」而拒绝对话。
5. `dsh plugin add` 后无需改 DSH 源码即可启用。

---

## 2. 调查结论：DSH 插件规范

官方入口：

- 文档站：https://deepseek-harness.github.io/deepseek-harness/
- 第一个插件：`/develop/basic/`
- 开发一个工具：`/develop/basic/tool`
- 插件配置：`/develop/basic/config`
- 打包安装：`/develop/basic/publish`
- 扩展 cookbook：`docs/cookbook/extension-cookbook.md`
- 架构：`docs/architecture.md`
- 能力 seams：`docs/capability-seams.md`

DSH 仍处于 **developer preview**，接口可能不兼容升级。插件必须把 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 等写成 peerDependencies，并在 README 标明已验证的 DSH 版本。

### 2.1 插件是什么

插件是一个 ESM 模块，至少导出：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'mxpage'
export const inject = ['tools']   // 需要的服务，框架保证就绪后再 apply

export function apply(ctx: Context, config: Config) {
  // 在这里注册工具 / 服务 / 事件 / effect
}
```

三种形态：

| 形态 | 何时用 |
|------|--------|
| 函数导出 `name` + `apply` | 大多数工具插件（本项目默认） |
| `export default { name, inject, apply }` | 希望把元数据集中在对象上 |
| `class extends Service` | 需要向其他插件提供 `ctx.mxpage` 服务时 |

注意：不要 `export default function apply`。Loader 会丢弃没有具名 `apply`/`name` 的函数默认导出。

`inject` **必须是字符串数组**。对象形式 `{ required, optional }` 会被 Loader 误读成服务名，可能导致启动直接挂掉。

```ts
export const inject = ['tools', 'attachments', 'jobs']  // 正确
// export const inject = { required: ['tools'] }        // 错误，不要写
```

本插件最低需要：

- 必选：`tools`
- 强烈建议：`attachments`（把生成图变成可回放附件）、`jobs`（整页/批量后台任务；同时要求 profile 已加载 `@deepseek-ai/dsh-tool-jobs`）
- 可选：`llm`（文本分析/规划走会话模型）、`systemPrompt`（注入电商工作流说明）、`fs`（读写工作区）、`skills`

通过 `ctx` 注册的内容在插件卸载时自动清理。需要手动释放的定时器 / 队列，用 `ctx.effect(() => { …; return () => cleanup() })`。

函数形态插件 **禁止 `export default`**。Loader 会丢弃带 default export 的函数插件。对象形态 / 类形态才使用 `export default`。

### 2.2 Config 必须是 Schemastery schema

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  imageBaseUrl: string
  imageApiKeyEnv: string
  imageModel: string
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  imageBaseUrl: Schema.string().default('https://api.openai.com/v1'),
  imageApiKeyEnv: Schema.string().default('MXPAGE_IMAGE_API_KEY'),
  imageModel: Schema.string().default('gpt-image-2'),
  timeoutMs: Schema.number().default(180_000),
})
```

规则：

- 必须同时导出 TypeScript `interface Config` 和同名 `const Config` schema。
- 不要导出普通对象当 Config，不满足 Standard Schema。
- 部署间会变的值一律进 Config，禁止硬编码超时、模型名、输出目录。
- 非法配置必须在加载时失败（响亮失败），不要静默回退。
- 改 `cordis.yml` 的 `config` 会触发插件 HMR：旧实例卸载，注册全部撤销。

### 2.3 工具 DSL：`defineTool`

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'mxpage_analyze_product',
  description: 'Analyze product photos and return structured selling-point JSON.',
  parameters: {
    project_id: { type: 'string', description: 'Existing project id; omit to create one' },
    image_paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Workspace-relative or absolute product image paths',
    },
  },
  output: {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  timeoutMs: 120_000,
  async execute(args, exec) {
    exec.signal.throwIfAborted?.()
    return runAnalyze(args, exec.signal)
  },
}))
```

要点：

- `parameters` 用 typed DSL，不是手写 JSON Schema。必填写 `required: true`；可选字段 **省略 `required`**，不要写 `required: false`。
- `execute` 只返回 `output.schema` 对应的规范 JSON。不要返回 content block。
- `output.render` 必须纯函数：无 IO、无时钟、无随机。回放会话时会再跑一遍。
- **面向模型的 render 保持 text-only。** 把图片写进会话历史的正确方式是 Host 侧 `ctx.attachments.saveImage(...)`，再在规范值里返回 attachment id / 工作区路径。社区成熟做法（如 `dsh-image-gen`）刻意不让工具结果带 image block，以免文本-only 路由拒绝整段历史。
- 长任务：抄 `dsh-tool-bash`。`ctx.jobs.start({ kind: 'mxpage_page', label, owner: exec.agent, run: () => ({ cancel, done }) })`。`run()` **同步**返回 JobHooks；须先 `declare module` 扩展 `JobKindMap`。`exec.signal.aborted` 时禁止 start。启动后改用 job 自有 AbortController。规范值 `{ kind: 'background', jobId }`。Agent 用内置 `job_output` / `mxpage_job_status` 轮询。
- 单张生图仍走前台 `execute`，必须尊重 `exec.signal`（取消 / 超时 120–180s）。整页 / 批量禁止在一次 tool call 里同步生成全部图片。
- 基础设施失败 `throw`；业务失败写进返回值（`ok: false, error: '…'`），让模型能读懂下一步。
- 工具执行流水线：`tools/pre-execute` → guard → `tools/execute` → `tools/post-execute` → `tools/result`。权限/审批可挂在 pre-execute，本插件默认不新增权限闸，沿用部署已有策略。

### 2.4 Bundle / Profile / 加载顺序

两个概念：

| 概念 | 回答的问题 | 谁维护 |
|------|------------|--------|
| **bundle** | 这个包贡献哪一层 patch？ | 插件作者 |
| **profile** | 启动时按什么顺序叠哪些 bundle？ | 用户 / `dsh plugin` |

可分发最小文件：

```
dsh-mxpage/
  package.json          # dsh.bundle.patch 必须存在
  cordis.patch.yml      # 按包名引用，不是源码路径
  index.js              # 或 lib/index.js 预构建产物
  skills/               # 可选，随包分发
```

`package.json` 关键字段：

```json
{
  "name": "dsh-mxpage",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml", "skills"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/schemastery": "*"
  }
}
```

没有 `dsh.bundle` 的包会被当成普通 npm 依赖，`dsh plugin` 会警告且不激活任何层。

`cordis.patch.yml`：

```yaml
- insert:
    - id: mxpage
      name: dsh-mxpage
      config:
        imageModel: gpt-image-2
        defaultLanguage: zh-CN
```

安装：

```bash
# 本地开发
dsh plugin --profile web add ./dsh-mxpage

# GitHub（不会自动 build；必须提交 JS 或自包含 prepare）
dsh plugin --profile web add github:owner/dsh-mxpage#<sha>

# npm
dsh plugin --profile web add dsh-mxpage

# tarball（推荐对外分发）
dsh plugin --profile web add ./dsh-mxpage-0.1.0.tgz
```

验证：

```bash
dsh --profile web --dump-config   # 应出现 "# == dsh-mxpage"
dsh --profile web web
```

加载顺序（后层整行覆盖，**不做 deep merge**）：

1. profile 声明的 bundles（先 `@deepseek-ai/dsh-base`，再按安装顺序）
2. `$DSH_HOME/profiles/<name>/cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`
4. 命令行 `--patch` overlay

因此 bundle 里只放安全默认值；用户覆盖必须重述被改的整段 `config`。

Git 源码安装的坑：pnpm ≥ 10 默认拒绝跑 git 依赖的 `prepare`。作者应发布预构建 JS / `.tgz`；若坚持源码安装，用户要在 profile 的 `pnpm-workspace.yaml` 写 `allowBuilds: dsh-mxpage: true`。

### 2.5 图片、附件、技能

- `ctx.attachments`：先 `saveImage({ data: Uint8Array, mediaType, name })`，得到 `ImageAttachmentRef`（字段 `attachmentId`，不是 `id`）。
- 内置 `read_image` 只有在 `ctx.attachments` 存在、且当前路由模型声明了 `input: [text, image]` 时才会真正把图送给模型。
- 工作区副本仍然要写盘，便于 `read` / 导出 / 用户用资源管理器取图。
- Skill 是「给模型看的说明书」，不是插件。目录约定：`skills/<kebab-name>/SKILL.md`。发现顺序大致是：项目 `.dsh/skills` → `.agents/skills` → 自定义根 → 用户根 → bundle 自带。Agent 先看到目录短描述，需要时调用 `skill` 工具加载全文。
- 本插件两者都做：Skill 负责「何时按什么顺序调哪些工具」；工具负责真正执行。

### 2.6 三角色能力拆分（本项目怎么用）

官方建议一个能力拆成：

- Service Definition（类型 + `ctx` 键）
- Service Provider（真正执行）
- Consumer（`defineTool` 暴露给模型）

第一期 **不拆包**。官方原文：角色不需要独立演进时，不要预先拆包。`dsh-mxpage` 单包内部分模块即可：`src/service.ts`（项目存储）+ `src/provider.ts`（图像 HTTP）+ `src/tools/*.ts`。若未来要换 ComfyUI / 本地 SD，再把 provider 抽成独立 bundle。

### 2.7 Web UI 插件（二期可选）

若做设置页 / Studio 面板，需要额外声明 `dsh.client`，浏览器侧只能 require 白名单模块（react、cordis、ui-slots、ui-primitives），其余必须打进 client bundle。一期只做 Host 工具 + Skill，用 DSH 已有附件预览展示生成图。

---

## 3. 调查结论：MxPage 能力盘点

仓库：https://github.com/ziguishian/MxPage  
定位：一键生成电商头图及详情页。技术栈 Next.js 14 + Electron + Prisma/SQLite + OpenAI-compatible。

### 3.1 可复用内核（必须带走）

| 模块 | 路径 | 作用 |
|------|------|------|
| 商品分析 | `lib/services/analysis-service.ts` + `lib/ai/prompts/analysis.ts` + `lib/ai/schemas/product-analysis.ts` | 最多 10 张商品图 → 结构化卖点 JSON |
| 页面规划 | `lib/services/planner-service.ts` + `lib/ai/prompts/planning.ts` | 1–5 头图 + 1–10 详情模块 + visualStyleGuide |
| Visual Prompt Agent | `lib/services/visual-prompt-agent.ts` | 每种图生成前细化 finalPrompt / negativePrompt / qualityChecklist |
| 分镜生成/编辑 | `lib/services/generation-service.ts` + `lib/ai/prompts/generation.ts` | generate / regenerate / edit(repaint\|enhance\|translate) + 版本 |
| 图像适配器 | `lib/ai/adapters/openai-compatible.ts` | `/images/generations`、`/images/edits`，多参考图，gpt-image-2 |
| 小红书工作流 | `lib/services/xiaohongshu-service.ts` | 规划 → Prompt 审核 → 生图 → 编辑 |
| 后台任务 | `lib/services/task-service.ts` / `workflow-task-service.ts` | 避免长请求 504，对应 DSH 的 `ctx.jobs` |

分析输出 schema（必须保持字段稳定，便于 Skill 和工具契约）：

```ts
{
  productName, category, subcategory, material, color,
  styleTags[], targetAudience[], usageScenarios[],
  coreSellingPoints[], differentiationPoints[],
  userConcerns[], recommendedFocusPoints[],
  additionalInformation, generationRequirements,
  suggestedSectionPlan: [{ type, title, goal }]
}
```

规划支持的模块类型：

`hero | selling_points | scenario | detail_closeup | specs | material | comparison | gift_scene | brand_trust | summary | custom`

VisualStyleGuide 建议字段（从 MxPage 规划结果迁入，写入 `style-guide.json`）：

`styleName, colorPalette, backgroundSystem, lighting, cameraLanguage, typography, layoutRules, propRules, productRenderingRules, negativeStyleConstraints`

原 Prisma 状态机对应关系：`DRAFT → created`，`ANALYZED → analyzed`，`PLANNED → planned`，`EDITING → editing`，`COMPLETED → generated`。资产角色：`MAIN / ANGLE / DETAIL / REFERENCE / GENERATED / EXPORTED`。

画幅：头图默认 `1:1`（1024×1024），详情默认 `3:4` 或 `9:16`（1024×1536）。  
内容语言：至少 `zh-CN` / `en` / `ja` / `ko`。  
VPA mode：`ecommerce_section | xiaohongshu_page | image_edit`。

MxPage 提示词里有一批「物理真实约束」（商品几何不可反转、禁止逆风气流、主体与参考图一致、避免乱码文字等）。这些约束是转化率相关的领域知识，必须原样迁到 `src/prompts/`。

### 3.2 不要带走

- `app/api/**` Next Route Handler
- Prisma schema / SQLite 作为唯一存储（改成工作区 JSON + 可选本地 SQLite）
- Electron / `localStorage` 存 API Key
- Radix + Tailwind 整套页面
- SVG fallback 作为一期默认路径（可作为二期降级，不作为主路径）

### 3.3 与现有 DSH 生图插件的定位差

| 插件 | 形态 | 缺口 |
|------|------|------|
| dickpy/dsh-imagegen | 画布 + 电商套图 UI | 有套图结构，但没有「先分析再规划再 VPA」的详情页叙事 |
| shanliuling/dsh-image-gen | Studio + 多模型 + ComfyUI | 通用创作，不是电商详情页工作流 |
| xiaoyuink/dsh-image-create | 侧栏 + `generate_image` 工具 | 单次文生图/图生图 |
| LeemanCheung/dsh-image-gen | `image_gen` + attachment | 单次生成 |
| 本插件 dsh-mxpage | 分析→规划→VPA→分镜 | **结构化详情页生产**，不是画廊 |

不要做成「又一个 generate_image」。模型在对话里看到的工具名应表达电商工序，而不是通用绘画。

---

## 4. 架构设计

### 4.1 推荐形态

**单 bundle：`dsh-mxpage`**

```
用户自然语言
    │
    ▼
Skill: mxpage-ecommerce-page          ← 告诉模型工序与工具顺序
    │
    ▼
Tools (ctx.tools.register)            ← 真正执行
    │
    ├─ mxpage service                 ← 项目/模块/版本状态机
    ├─ OpenAI-compatible image client ← 生图/修图 HTTP
    ├─ ctx.llm（可选）                 ← 分析/规划/VPA 文本
    ├─ ctx.jobs                       ← 整页/批量后台
    └─ ctx.attachments + workspace    ← 耐久图片 + 可导出文件
```

一期不挂 `dsh.client`。生成图通过附件预览出现在对话里，文件同时落在工作区，用户可以直接拿走上架。

### 4.2 三种实现路径与取舍

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| A. 只做 Skill | 用 bash + curl 调外部 API | 零插件代码 | 无状态、无附件、取消/重试差 | 否 |
| B. Host 工具 + Skill + 工作区（推荐） | Cordis 插件注册工序工具 | 符合规范、可发布、可取消、可回放 | 一期没有独立 Studio UI | **采用** |
| C. 完整 Web Studio | 再加 `dsh.client` 面板 | 体验接近原 MxPage | 客户端打包白名单限制、工作量大 | 二期 |

### 4.3 数据流

```
[商品图] --save--> workspace/assets/ + attachments
    │
    ▼
mxpage_analyze_product
    │  vision + schema
    ▼
analysis.json
    │
    ▼
mxpage_plan_page
    │  counts + style guide + section list
    ▼
plan.json + style-guide.json
    │
    ▼
for each section:
    mxpage_refine_prompt  →  prompts/<sectionKey>.json
    mxpage_generate_section → output/<sectionKey>.png + versions/
    │
    ▼
mxpage_export_page → output/export.zip | 路径清单
```

整页一键走 `mxpage_generate_page`：内部串起上述步骤，默认作为 background job 返回 `jobId`。

### 4.4 工作区布局（替代 Prisma）

默认根：`$DSH_HOME/mxpage/projects/<projectId>/`  
也可在 Config 里改成当前 workspace 下的 `.mxpage/`。

```
<projectId>/
  project.json              # 元数据：名称、语言、画幅、状态机
  analysis.json             # ProductAnalysisOutput
  plan.json                 # sections[]
  style-guide.json          # visualStyleGuide
  assets/
    main.jpg
    detail-01.jpg
  prompts/
    hero_01.json
    detail_02_specs.json
  output/
    hero_01.png
    detail_02_specs.png
  versions/
    hero_01/
      v1.png
      v1.meta.json
  tasks/
    <taskId>.json
```

`project.json` 状态机：

```
created → analyzing → analyzed → planning → planned
       → generating → generated
       → editing → generated
       → failed
```

每个 `PageSection`：`sectionKey, order, type, title, goal, copy, visualPrompt, status, currentOutputPath, currentVersionId`。

### 4.5 文本模型 vs 图像模型

| 步骤 | 默认通道 | 备选 |
|------|----------|------|
| 分析 / 规划 / VPA | `ctx.llm` 当前会话路由（需视觉） | Config `textBaseUrl` + `textModel` |
| 生图 / 修图 | Config `imageBaseUrl` + `imageModel` | 不走 DSH LLM adapter（官方 adapter 是聊天补全，不是 Images API） |

这是关键设计：DSH 内置 LLM 插件解决的是 chat/completions；MxPage 生图走的是 `/v1/images/generations` 与 `/v1/images/edits`。两者不要混在一个 adapter 里。

分析/规划需要把商品图送给视觉模型。实现时：

1. 优先用 `ctx.llm` + 已声明 `input: [text, image]` 的路由；
2. 若当前路由不支持图像，回退到 Config 里的 OpenAI-compatible 视觉文本端点；
3. 两者都不可用时，工具返回明确错误，而不是静默用纯文本「猜」商品。

---

## 5. 工具契约

命名约定：`mxpage_` 前缀，动词 + 宾语，全部小写 + 下划线。描述写给模型看，说明 **何时调用、输入从哪来、输出写到哪**。

工具全集（与实现阶段对齐）：

`mxpage_create_project` · `mxpage_add_asset` · `mxpage_analyze_product` · `mxpage_plan_page` · `mxpage_refine_prompt` · `mxpage_generate_section` · `mxpage_edit_section` · `mxpage_generate_page` · `mxpage_project_status` · `mxpage_job_status` · `mxpage_job_cancel` · `mxpage_export_page`

### 5.1 `mxpage_create_project`

创建项目并登记商品图。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 否 | 默认取商品名或「untitled」 |
| image_paths | string[] | 是 | 工作区或绝对路径，最多 10 张 |
| main_image_path | string | 否 | 主图；默认第一张 |
| language | string | 否 | 默认 Config.defaultLanguage |
| aspect_ratio | `"1:1"\|"3:4"\|"9:16"` | 否 | 详情模块默认画幅 |

输出：`{ projectId, assetCount, mainAssetPath, workspaceDir }`。

副作用：复制图片到 `assets/`（不移动用户原文件），写 `project.json`。

### 5.1.1 `mxpage_add_asset`

向已有项目追加商品图或参考图。参数：`project_id`，`image_path` 或 `attachment_id`，`role: "main" | "angle" | "detail" | "reference"`。主图变更必须显式 `role=main`，否则不悄悄替换锚定图。

### 5.1.2 `mxpage_project_status`

只读。返回状态机、各 section 的 `status/outputPath/versionId`、进行中的 job。分析/规划未完成时也能调用，方便 Agent 在中断后恢复。

### 5.2 `mxpage_analyze_product`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| project_id | string | 是 | |
| model | string | 否 | 覆盖文本/视觉模型 |

输出：`ProductAnalysisOutput` + `{ projectId, modelUsed }`。  
写 `analysis.json`，状态 → `analyzed`。  
超时默认 120s。需要视觉。

### 5.3 `mxpage_plan_page`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| project_id | string | 是 | 必须已分析 |
| hero_count | number | 否 | 1–5，默认 3 或由模型决定 |
| detail_count | number | 否 | 1–10，默认 6 |
| platform | `"ecommerce"\|"xiaohongshu"` | 否 | 默认 ecommerce |
| language | string | 否 | |

输出：`{ visualStyleGuide, sections: PlannedSection[], previewConfig }`。  
写 `plan.json`、`style-guide.json`。状态 → `planned`。

### 5.4 `mxpage_refine_prompt`

VPA。生成前必须调用（Skill 强制）；工具内部 `generate_section` 在未提供 `prompt_override` 时也会自动调一次，避免模型漏步骤。

| 参数 | 类型 | 必填 |
|------|------|------|
| project_id | string | 是 |
| section_key | string | 是 |
| mode | `"ecommerce_section"\|"xiaohongshu_page"\|"image_edit"` | 否，默认按平台 |

输出：`{ finalPrompt, negativePrompt, qualityChecklist }`。

### 5.5 `mxpage_generate_section`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| project_id | string | 是 | |
| section_key | string | 是 | 如 `hero_01` |
| prompt_override | string | 否 | 跳过 VPA 时使用 |
| reference_paths | string[] | 否 | 额外参考图；默认主图 + 已生成头图 |
| size | string | 否 | `1024x1024` / `1024x1536` |
| model | string | 否 | 覆盖图像模型 |

输出：

```ts
{
  ok: true,
  projectId: string
  sectionKey: string
  outputPath: string
  attachmentId?: string
  modelUsed: string
  versionId: string
}
```

实现要点：

1. 解析参考图 → data URL / multipart（与 MxPage adapter 一致）。
2. 调 `/images/generations` 或带参考图的 edits。
3. 落盘 `output/<sectionKey>.png` 与 `versions/`。
4. `ctx.attachments.saveImage`。
5. `timeoutMs` 建议 180_000，`isConcurrencySafe: false`（同一 section 禁止并行，避免版本打架）。不同 section 允许并行，由 service 层按 sectionKey 加锁。

长耗时可由 Config `generateAsJob` 改为后台任务。

### 5.6 `mxpage_edit_section`

| 参数 | 类型 | 必填 |
|------|------|------|
| project_id | string | 是 |
| section_key | string | 是 |
| mode | `"repaint"\|"enhance"\|"translate"` | 是 |
| instruction | string | mode=repaint/enhance 时必填 |
| target_language | string | mode=translate 时必填 |

走 `/images/edits`，以当前成品 + 主图为参考。产出新版本，不覆盖旧版本文件。

### 5.7 `mxpage_generate_page`

编排工具。参数：`project_id`，可选 `section_keys[]`（默认全部未成功模块）。

默认 `ctx.jobs.start`，立即返回 `{ kind: 'background', jobId }`。  
Job 内部顺序：缺分析就分析 → 缺规划就规划 → 先生成全部 hero → 以其为锚定再生成 detail。  
进度写 `tasks/<jobId>.json`，可用 `mxpage_job_status` 查询。

### 5.8 `mxpage_job_status` / `mxpage_job_cancel`

查询/取消后台任务。输出包含 `state, progress, currentSection, error?`。

### 5.9 `mxpage_export_page`

参数：`project_id`，`format: "paths" | "zip"`。  
返回每个 section 的最终图路径、所用 prompt、分析摘要。zip 写入 `output/export-<timestamp>.zip`。

### 5.10 工具对模型的可见策略

- 日常对话只暴露工序工具，不暴露内部 HTTP 细节。
- `mxpage_generate_page` 与单步工具共存：Skill 教模型「用户要一整页就调编排；用户只要改一张就调 section」。
- 不要再注册一个通用 `generate_image`，以免和社区生图插件抢工具名、打乱模型选择。

---

## 6. Skill 设计

随包分发三个 skill，目录名 kebab-case。

### 6.1 `skills/mxpage-ecommerce-page/SKILL.md`

Frontmatter 至少包含 `name`、`description`（出现在会话 skill 目录里）。

正文必须写清：

1. 触发条件：用户提到电商头图、详情页、主图、卖点图、淘宝/天猫/京东/Shopee 详情。
2. 强制工序：create/登记图片 → analyze → plan →（逐张 refine + generate）或 generate_page。
3. 主图锚定：后续模块必须把已生成 hero 和原始商品图同时当参考。
4. 失败处理：额度/401/模型不支持时停止并告诉用户改 Config，不要改用纯文本编造图片。
5. 输出时用工具返回的路径，不要自己用 bash 改图。

### 6.2 `skills/mxpage-xiaohongshu/SKILL.md`

四步：内容规划 → Prompt 审核（把 refine 结果展示给用户确认，若部署有 `ask_user_question` 则调用）→ 生图 → 编辑。画幅默认 `3:4`。VPA mode = `xiaohongshu_page`。

### 6.3 `skills/mxpage-batch-sku/SKILL.md`

多 SKU：每个商品一个 project，串行或受 Config `maxParallelProjects` 限制的有限并行。禁止把不同商品的参考图混进同一 project。

Skill 只描述策略，不复制整份提示词。提示词留在 `src/prompts/`，由工具调用。

---

## 7. 配置项

全部进 Schemastery，均可在 profile 的 `cordis.patch.yml` 覆盖。

```ts
export interface Config {
  /** 图像 API 根路径，需含 /v1 */
  imageBaseUrl: string
  /** 图像 API Key 所在环境变量名，不写明文 key */
  imageApiKeyEnv: string
  /** 默认图像模型 */
  imageModel: string
  /** 可选：独立文本/视觉端点。空则优先 ctx.llm */
  textBaseUrl?: string
  textApiKeyEnv?: string
  textModel?: string
  /** 项目根。空则 $DSH_HOME/mxpage/projects */
  workspaceDir?: string
  defaultLanguage: 'zh-CN' | 'en' | 'ja' | 'ko'
  defaultHeroCount: number
  defaultDetailCount: number
  defaultDetailAspectRatio: '3:4' | '9:16'
  timeoutMs: number
  analyzeTimeoutMs: number
  maxReferenceImages: number
  maxParallelSections: number
  generateAsJob: boolean
  allowSvgFallback: boolean
}
```

默认值建议：

| 字段 | 默认 |
|------|------|
| imageBaseUrl | `https://api.openai.com/v1` |
| imageApiKeyEnv | `MXPAGE_IMAGE_API_KEY` |
| imageModel | `gpt-image-2` |
| defaultLanguage | `zh-CN` |
| defaultHeroCount | 3 |
| defaultDetailCount | 6 |
| defaultDetailAspectRatio | `3:4` |
| timeoutMs | 180000 |
| analyzeTimeoutMs | 120000 |
| maxReferenceImages | 4 |
| maxParallelSections | 2 |
| generateAsJob | true |
| allowSvgFallback | false |

密钥只从环境变量读。日志与工具输出必须脱敏（redact `sk-`、Bearer）。

---

## 8. 仓库与包布局

独立仓库，不要 fork 整个 MxPage。从 MxPage 只复制 prompts/schemas/adapter 协议，并在 NOTICE 中保留原许可证与出处。

本工位路径：`/workspace/dsh-plugins/dsh-mxpage/`。

```
dsh-mxpage/
  package.json
  cordis.patch.yml
  tsdown.config.ts
  tsconfig.json
  README.md
  README.zh-CN.md
  LICENSE                  # 建议 MIT，与两边上游一致
  NOTICE                   # MxPage prompt/schema 出处
  src/
    index.ts               # name / inject / Config / apply
    config.ts
    ctx.d.ts               # 若提供 ctx.mxpage 服务
    service/
      project-store.ts     # 读写工作区
      state-machine.ts
    provider/
      openai-images.ts     # generations / edits
      vision-text.ts       # 分析/规划/VPA 的 LLM 调用
    pipeline/
      analyze.ts
      plan.ts
      visual-prompt.ts
      generate.ts
      edit.ts
      export.ts
    prompts/               # 从 MxPage 迁入并去框架耦合
      analysis.ts
      planning.ts
      generation.ts
      visual-prompt-agent.ts
    schemas/
      product-analysis.ts
      section-plan.ts
      visual-prompt.ts
    tools/
      create-project.ts
      analyze.ts
      plan.ts
      refine-prompt.ts
      generate-section.ts
      edit-section.ts
      generate-page.ts
      job.ts
      export.ts
    util/
      images.ts            # 读盘、mime、resize 上限
      redact.ts
  skills/
    mxpage-ecommerce-page/SKILL.md
    mxpage-xiaohongshu/SKILL.md
    mxpage-batch-sku/SKILL.md
  test/
    schemas.test.ts
    state-machine.test.ts
    prompts.snapshot.test.ts
    provider.images.test.ts   # mock HTTP
    tools.execute.test.ts
```

`src/index.ts` 骨架：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { registerMxpageTools } from './tools/index.ts'
import { Config, type Config as MxpageConfig } from './config.ts'

export const name = 'mxpage'
export const inject = ['tools', 'attachments', 'jobs']
export { Config }

export function apply(ctx: Context, config: MxpageConfig) {
  registerMxpageTools(ctx, config)
}
```

构建：`tsdown` 把 `src/index.ts` 打成自包含 `index.js`（或 `lib/index.js`）。发布物必须能被 Node 直接加载，不依赖 monorepo path alias。

---

## 9. 从 MxPage 迁移时的改造清单

| 原实现 | DSH 对应 |
|--------|----------|
| Prisma `Product` / `PageSection` | `project.json` + `plan.json` |
| Next `FormData` 上传 | 工具参数里的路径；用户先把图放到 workspace 或用 DSH 附件 |
| `localStorage` API Key | Config + env |
| `createTask` + 前端轮询 | `ctx.jobs` + `mxpage_job_status` |
| `assetToDataUrl` | `src/util/images.ts`，限制 20MiB / 边长 8192，与 `dsh-attachment-local` 默认值对齐 |
| `generateStructured` + Zod | 优先 JSON schema / 严格 JSON + 本地 Zod 校验 + 一次 repair |
| SVG fallback | Config 关闭；二期再做 |
| Electron `STORAGE_ROOT` | `$DSH_HOME/mxpage` 或 workspace `.mxpage` |

提示词迁移原则：

- 去掉「返回给 Next 前端」的措辞。
- 保留物理真实约束、主体一致性、双语 visualPrompt。
- 系统提示改为「只输出一个 JSON 对象」。
- 不要在 prompt 里出现 MxPage 产品名，避免模型在图上写错品牌。

---

## 10. 安装、开发与调试

### 10.1 开发循环

```bash
# 1. 构建
pnpm build

# 2. 装进本地 profile（目录需含 dsh.bundle）
DSH_HOME=/workspace/.dsh-home \
  /workspace/dsh-runtime/node_modules/.bin/dsh plugin --profile web add ./dsh-plugins/dsh-mxpage

# 3. 看合成配置
DSH_HOME=/workspace/.dsh-home \
  /workspace/dsh-runtime/node_modules/.bin/dsh --profile web --dump-config

# 4. 启动
export MXPAGE_IMAGE_API_KEY=sk-...
# 预览已由 startup.sh 拉起官方 dsh web
```

开发期也可用 overlay，不必每次 add：

```yaml
# scratch/cordis.yml
- insert:
    - id: mxpage
      name: '/abs/path/to/dsh-mxpage/index.js'
      config:
        imageModel: gpt-image-2
```

```bash
pnpm dsh web --patch ./scratch/cordis.yml
```

注意 overlay 用绝对路径；bundle 安装用包名。

### 10.2 对话验收用例

1. 「工作区有 `samples/bottle.jpg`，给它出一套 3 头图 + 5 详情的中文详情页。」
   期望：依次调用 create → analyze → plan → generate_page（或逐张 generate），工作区出现 png。
2. 「把 specs 那张翻译成英文，文字不能糊。」
   期望：`mxpage_edit_section` mode=translate。
3. 「只要一张白底主图，1:1。」
   期望：不走整页编排，只生成 `hero_01`。
4. 取消正在跑的整页任务。
   期望：job 停止，已完成的 section 保留。

### 10.3 发布

```bash
pnpm build
pnpm pack          # 得到 tgz，给不会跑 prepare 的用户
pnpm publish       # 可选
```

仓库设置 topic：`dsh-plugin`、`dsh`、`deepseek-harness`。  
README 必须写清：peer 版本、环境变量、与 `dsh-imagegen` 的差异、安全声明（会代表用户调用付费图像 API）。

---

## 11. 分阶段计划

逐步任务以 [实现计划](../superpowers/plans/2026-09-12-dsh-mxpage-plugin.md) 为准。下面是阶段目标，供对照。

### P0 — 可安装的空包（0.5 天）

- package.json / cordis.patch.yml / apply 打日志
- `dsh plugin add` + `--dump-config` 能看到层
- README 安装段

### P1 — 单张生图闭环（2–3 天）

- `mxpage_create_project` + `mxpage_generate_section`（可先用手工 prompt）
- OpenAI Images provider
- 落盘 + `saveImage`
- 单测：provider mock、路径安全（禁止写出 workspace 外）

### P2 — 分析 / 规划 / VPA（3–4 天）

- 迁 prompts + schemas
- `mxpage_analyze_product` / `mxpage_plan_page` / `mxpage_refine_prompt`
- 视觉通道选择逻辑（ctx.llm vs 独立端点）
- Skill `mxpage-ecommerce-page`

### P3 — 整页编排与编辑（2–3 天）

- `mxpage_generate_page` + jobs
- `mxpage_edit_section`（repaint / enhance / translate）
- 版本目录
- 主图锚定：detail 默认参考 = 原主图 + 第一张成功 hero

### P4 — 小红书 + 批量 + 导出（2 天）

- 两个附加 Skill
- `mxpage_export_page`
- 并发上限与任务取消

### P5 — 打磨与发布（1–2 天）

- 脱敏、超时、配额错误文案
- tgz / npm
- topic `dsh-plugin`
- 可选：`dsh.client` 设置卡片（只配 endpoint / model / 输出目录）

合计约 2 周日历时间（单人全职）。P1 结束后就可以在真实 DSH 里演示「一句话出一张电商主图」。P3 达到原始需求的对话验收。

---

## 12. 测试与验收

最低测试集：

| 层 | 测什么 |
|----|--------|
| schemas | 合法/缺字段/多余字段；repair 前后 |
| state-machine | 非法跳转被拒绝（未分析就 plan） |
| provider | 对 mock `/images/generations` 的 multipart 字段、错误码映射 |
| tools | execute 取消、超时、路径穿越、缺主图 |
| prompts | snapshot，防止迁移时丢失物理约束段落 |
| 手工 | 用一张真实商品图跑通 P1/P2 |

验收不看「好不好看」（模型非决定性），看：

- 工具契约稳定；
- 失败可解释；
- 主体参考图被实际传给 Images API（用 mock 断言 form 里有 image 字段）；
- 工作区文件可独立于 DSH 打开。

---

## 13. 风险、限制与合规

1. **DSH preview 破坏性变更。** 锁定 peer 范围，CHANGELOG 记录已验证版本。
2. **图像 API 计费。** 工具描述和 Skill 必须提醒会消耗配额；整页默认先 plan 再确认（若部署有 `ask_user_question`，Skill 要求在 `generate_page` 前问一次）。
3. **商品图版权 / 真人肖像。** 插件不审核图源，README 声明用户自负。
4. **模型在图上写字不稳定。** 继承 MxPage 的 translate/edit 路径，不在一期承诺「100% 可上架文字」。
5. **一致性。** 没有 MxPage 原 UI 的人工选主图流程时，必须在 create_project 明确 main image，否则锚定会漂。
6. **不要记录用户图到远程日志。** 默认只写本地 workspace。
7. **MxPage 许可证。** 上游为 MIT（Copyright © 2026 灵矩绘境）。可以移植 prompts / schemas / 流水线逻辑，但必须保留原作者署名，并在 `NOTICE` 写明出处。不要宣称本插件是 DeepSeek 官方产品，也不要整仓复制 Next / Electron / Prisma。本插件建议同样 MIT。
8. **与其它生图插件并存。** 工具名全部 `mxpage_*`，避免和 `generate_image` 冲突。两个插件同时装时，Skill 负责把电商需求路由到本插件。

---

## 14. 开发时的硬约束清单

实现阶段逐条核对：

- [ ] 导出的是 `name` + `apply`，不是 default function
- [ ] `Config` 是 Schemastery schema
- [ ] `package.json` 有 `dsh.bundle.patch`
- [ ] 发布物含预构建 JS，Git 安装也能加载
- [ ] `inject` 至少包含 `tools`
- [ ] 工具可选参数不写 `required: false`
- [ ] `execute` 尊重 AbortSignal
- [ ] 面向模型的 render 只有 text
- [ ] 图片先 `saveImage` 再出现在会话里
- [ ] 密钥只来自环境变量，日志脱敏
- [ ] 工作区写操作做 path normalize，拒绝 `..`
- [ ] 仓库 topic 含 `dsh-plugin`

---

## 15. 参考链接

- MxPage：https://github.com/ziguishian/MxPage
- DeepSeek Harness：https://github.com/deepseek-ai/deepseek-harness
- DSH 文档：https://deepseek-harness.github.io/deepseek-harness/
- 第一个插件：https://deepseek-harness.github.io/deepseek-harness/develop/basic/
- 开发工具：https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool
- 插件配置：https://deepseek-harness.github.io/deepseek-harness/develop/basic/config
- 打包安装：https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish
- 发现插件：GitHub topic `dsh-plugin`
- 社区对照：https://github.com/dickpy/dsh-imagegen （电商套图 UI，无分析规划）

---

## 16. 下一步

实现按 [计划](../superpowers/plans/2026-09-12-dsh-mxpage-plugin.md) 从 P0 开工。包名 `dsh-mxpage`，一期不做 `dsh.client`，SVG fallback 默认关闭。

未按计划执行前不写插件实现代码，避免把 Next.js 应用误装进 Cordis 插件槽。
