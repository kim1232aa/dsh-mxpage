# DSH 插件规范调查报告

日期：2026-09-12  
对照运行时：本机 `dsh-runtime` 的 `@deepseek-ai/dsh@0.1.5-rc.1`（`dsh-web-app@0.1.5-rc.2`）  
对照上游：MxPage `main`（https://github.com/ziguishian/MxPage）  
需求源：用户原话「把 MxPage 做成 DSH 的电商生图插件，**先调查插件规范，写开发文档**」

本文是规范调查的真源。实现以 [插件规格](../superpowers/specs/2026-09-12-dsh-mxpage-plugin-design.md) 为准；与本文冲突时，以 **本机 d.ts + 官方文档** 为准，再改规格。

---

## 0. 调查范围

| 来源 | 用途 |
|------|------|
| https://deepseek-harness.github.io/deepseek-harness/develop/basic/ | 第一个插件 |
| …/develop/basic/tool | `defineTool` 教程 |
| …/develop/basic/config | Schemastery Config |
| …/develop/basic/publish | bundle / `dsh plugin add` |
| …/en/reference/cookbook/adding-a-tool | 工具权威：jobs、abort、render 纯度 |
| …/en/develop/practice/ | 三角色；简单工具不要拆包 |
| 本机 `dsh-tools` / `dsh-jobs` / `dsh-attachment` / `dsh-skill` 的 `.d.ts` | 不可口说的 API |
| 本机 `dsh-tool-bash` | `ctx.jobs.start` 的官方写法 |
| MxPage `lib/ai/schemas/*`、`lib/ai/adapters/openai-compatible.ts`、`lib/services/*` | 要搬走的流水线 |
| 社区 `topic:dsh-plugin` 生图插件 | 定位差，避免撞名 |

---

## 1. 插件是什么（必须长这样）

### 1.1 函数插件（本项目采用）

官方教程与 `dsh-tool-bash` 一致：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'mxpage'
export const inject = ['tools', 'attachments', 'jobs']

export function apply(ctx: Context, config: Config) {
  // 注册工具；ctx 上的注册在卸载时自动撤销
}
```

| 规则 | 依据 |
|------|------|
| 必须导出具名 `name` + `apply` | 第一个插件教程 |
| **禁止** `export default function apply` | Loader 会丢弃无 `name` 的函数默认导出 |
| `inject` **必须是 `string[]`** | 对象 `{ required, optional }` 会被误读成服务名 |
| 对象形态 / `class extends Service` 才用 `export default` | 教程允许，本项目不需要 |
| 需要手动释放的定时器，用 `ctx.effect(() => { …; return cleanup })` | Cordis 生命周期 |

`inject` 本插件：`tools`（必选）、`attachments`（`saveImage`）、`jobs`（整页后台）。web profile 已装 `@deepseek-ai/dsh-tool-jobs` 与 attachment-local。

### 1.2 Config = Schemastery

必须 **同时** 导出 TypeScript `interface Config` 和同名 `const Config: Schema<Config>`。不要导出普通对象。非法配置加载时响亮失败，不要静默回退。改 patch 的 `config` 会 HMR：旧实例卸载。

密钥不进 schema 明文，只存 **环境变量名**（默认 `MXPAGE_IMAGE_API_KEY`）。

### 1.3 Bundle / Profile

| 概念 | 谁维护 | 本仓库 |
|------|--------|--------|
| bundle | 插件作者 | `dsh-plugins/dsh-mxpage` 的 `dsh.bundle.patch` |
| profile | 用户 / `dsh plugin` | 已有 `web`，不要另起 `sdk-minimal` |

`package.json` 没有 `dsh.bundle` 时，`dsh plugin add` 当普通 npm 依赖，**不会插入任何层**。

`cordis.patch.yml` 按 **包名** 引用：

```yaml
- insert:
    - id: mxpage
      name: dsh-mxpage
      config:
        imageModel: gpt-image-2
        defaultLanguage: zh-CN
```

开发 overlay 才用绝对路径指向 `src/*.ts`。加载顺序后层整行覆盖，**不做 deep merge**。

安装（本工位）：

```sh
DSH_HOME=/workspace/.dsh-home \
  /workspace/dsh-runtime/node_modules/.bin/dsh plugin --profile web add /workspace/dsh-plugins/dsh-mxpage
```

Git 源码安装：pnpm ≥10 默认不跑 `prepare`。对外发 **预构建 `index.js` 或 `.tgz`**。

验证：`dsh --profile web --dump-config` 出现 `# == dsh-mxpage`，且仍含 `# == @deepseek-ai/dsh-web-app`。

---

## 2. 工具 DSL（本机 d.ts 核实）

`defineTool`（`@deepseek-ai/dsh-tools` `DefineToolOptions`）：

| 字段 | 要点 |
|------|------|
| `name` | 全局唯一。本插件全部 `mxpage_*` |
| `description` | 给模型：何时调用、输入从哪来、输出写到哪 |
| `parameters` | 隐式 **open object**。必填 `required: true`；可选 **省略 `required`**，不要 `required: false` |
| `output.schema` | 显式 object 必须声明 `additionalProperties: true \| false` |
| `output.render` | **纯函数**：无 IO、无时钟、无随机；会话回放会再跑。本插件只返回 text block |
| `timeoutMs` | 协作超时，**永不发给模型**。声明了就必须把 `exec.signal` 传到底 |
| `isConcurrencySafe?(args)` | 只有返回 `true` 才允许并行；省略 = 互斥。同一 `section_key` 必须互斥 |
| `execute(args, exec)` | 只返回规范 JSON。`exec.signal` 必有；`exec.agent` 可选（job owner） |

错误策略（cookbook）：

- **基础设施**（网络断、schema 崩、未注入 jobs）→ `throw`，registry 标 `isError`
- **业务失败**（没 Key、未分析就 plan、额度 429）→ 规范值 `{ ok: false, error: '…' }`，让模型能读

流水线：`tools/pre-execute` → guard → `tools/execute` → `tools/post-execute` → `tools/result`。本插件不新增权限闸。

**不要** 在 `render` 里放 `image` block 或 base64。社区成熟做法：磁盘文件 + `saveImage`，规范值只含路径 / `attachmentId`。

---

## 3. Jobs（官方 bash 插件抄作业）

本机 `JobStart`：

```ts
interface JobStart {
  kind: JobKind        // 也是 id 前缀；默认只有 bash | subagent
  label: string
  owner?: Agent
  run(): JobHooks      // 同步返回 hooks，不是 async 工作函数
}
interface JobHooks {
  cancel(reason?: string): void   // 同步、幂等
  done: Promise<JobOutcome>       // 不得 reject
  readOutput?(): string
}
```

`JobKindMap` 只有 `bash` / `subagent`。自定义 kind **必须 declaration merging**：

```ts
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    mxpage_page: 'mxpage_page'
  }
}
```

官方 `dsh-tool-bash` 的后台分支（节选，已核实 `lib/index.js`）：

```js
return {
  kind: "background",
  jobId: jobs.start({
    kind: "bash",
    label: args.command,
    ...(exec.agent ? { owner: exec.agent } : {}),
    run: () => {
      const proc = ctx.shell.start(...)
      return {
        cancel: () => void proc.kill(),
        done: proc.done.then(() => processOutcome(proc)),
        readOutput: () => renderProcessRead(...),
      }
    },
  }),
}
```

规则：

1. `exec.signal.aborted` 时 **禁止** `start`（没有可返回的 jobId）。
2. `start` 成功后改用 **job 自有 AbortController**，不要继续绑 `exec.signal`。外层取消只停止等待，不杀已发布 job。
3. 规范值 `{ kind: 'background', jobId }`。render 可写 `started background job mxpage_page-1`，但 PTC 不得靠散文解析 id。
4. `inject` 含 `jobs`；缺失时 throw「请加载 `@deepseek-ai/dsh-jobs`」。

整页 `mxpage_generate_page` 必须走这条路径。单张 `generate_section` 走前台 + `exec.signal`。

---

## 4. Attachments

`ctx.attachments.saveImage` 入参（**字段名是 `data`，不是 `bytes`**）：

```ts
interface SaveImageAttachment {
  data: Uint8Array
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  name?: string   // 显示名，不当路径解析
}
```

返回 `ImageAttachmentRef`：`attachmentId`（不是 `id`）、`mediaType`、`bytes`、`width`、`height`、`name?`。

规范值里返回 `attachmentId` + 工作区相对路径。工作区副本仍要写盘，方便导出。

---

## 5. Skills

- 名称必须 kebab-case（`isSkillName`）。
- 磁盘约定：`skills/<name>/SKILL.md`，frontmatter 至少 `name`、`description`。
- 发现顺序大致：项目 `.dsh/skills` → `.agents/skills` → 自定义 → 用户 → **bundled**（`BUNDLED_SKILL_RANK = 600`）。
- 也可 `ctx.skills.register(...)` 内存注册。
- Skill 是说明书，不是插件。本包随 `files: ["skills"]` 分发。

本插件三个 skill 草稿：[skill-drafts/](./skill-drafts/)。

---

## 6. MxPage 源码对照（GitHub `main` 核实）

定位：一键电商头图/详情、小红书四步、批量、编辑/翻译。MIT，灵矩绘境。默认图像 `gpt-image-2`，文本 GPT 系列，OpenAI-compatible。Key 在浏览器 `localStorage`（DSH 侧改为 env）。

### 必须搬走

| 模块 | 路径 | 插件落点 |
|------|------|----------|
| 分析 schema | `lib/ai/schemas/product-analysis.ts` | `src/schemas/product-analysis.ts` |
| 规划 + style guide | `lib/ai/schemas/section-plan.ts` | `src/schemas/section-plan.ts` |
| VPA schema | `lib/ai/schemas/visual-prompt.ts` | `src/schemas/visual-prompt.ts` |
| Images adapter | `lib/ai/adapters/openai-compatible.ts` | `src/provider/openai-images.ts` |
| 分析/规划/VPA/生成服务 | `lib/services/*` | `src/pipeline/*` |
| 后台任务 | `task-service` / 轮询 | `ctx.jobs` |
| 物理真实约束提示词 | `lib/ai/prompts/*` | `src/prompts/*` + snapshot 测试 |

分析输出字段（Zod，稳定）：

`productName, category, subcategory, material, color, styleTags[], targetAudience[], usageScenarios[], coreSellingPoints[], differentiationPoints[], userConcerns[], recommendedFocusPoints[], additionalInformation (default ""), generationRequirements (default ""), suggestedSectionPlan[{ type, title, goal }]`

VPA 输出：`analysisSummary`（default ""）、`finalPrompt`（min 20）、`negativePrompt`、`qualityChecklist[]`。

VPA mode：`ecommerce_section | xiaohongshu_page | image_edit`。

资产角色：`MAIN / ANGLE / DETAIL / REFERENCE / GENERATED / EXPORTED`。  
Prisma 状态：`DRAFT/ANALYZED/PLANNED/EDITING/COMPLETED` → 工作区状态机 `created/analyzed/planned/editing/generated`。

Images API：

- `POST {baseUrl}/images/generations`
- `POST {baseUrl}/images/edits`
- 无参考图：`POST /images/generations` JSON
- 1 张参考图：multipart 字段 `image`（OpenAI 兼容；grok-imagine 实测 200）
- 2+ 张参考图：优先 JSON `{ images: [{ type: "image_url", url: dataURI }] }`（xAI 官方，grok-imagine 实测 200）；失败再试 multipart 重复字段 `images`（复数，实测 200）、`image[]`（OpenAI 文档）；再失败才降到 1 张
- 实测踩坑：multipart 重复 `image` 或 `image[]` 在 grok-imagine 上是上游 400，**不是**模型只能吃 1 张
- `grok-imagine-edit` 在当前中转 503（`No eligible Grok media accounts`），不要当主模型
- 响应 `b64_json` 或 `url`
- 图像超时调用方默认 120s（本插件 Config 180s）
- 不要把 Gemini Google 协议做一期主路径

### 不要搬走

Next `app/api/**`、Prisma、Electron、Radix/Tailwind、`localStorage` Key、默认 SVG fallback。

---

## 7. 社区生图插件（定位差）

| 仓库 | 工具名 | 缺什么 |
|------|--------|--------|
| ZhaoJun233/dsh-imagegen | `image_generate` | 无分析/规划/VPA |
| shanliuling/dsh-image-gen | Studio + 多模型 | 通用创作 |
| JuneLearn/dsh-image-tools | `image-generate` / `image-edit` | 单次生图 |
| llmpolska/oh-my-dsh | `omd_image` | 路由插件附带生图 |

本插件工具名 **全部 `mxpage_*`**。不要注册 `generate_image`、`image_generate`、`image-generate`。一期不挂 `dsh.client`（`dsh-imagegen` 有设置页，那是他们的形态）。

`dsh-imagegen` 的 `package.json` 验证了：`type: module`、`main: index.js`、`dsh.bundle.patch`、`files` 含预构建 JS。本包照抄这个分发面，不抄工具名。

---

## 8. 本插件必须遵守的硬清单

对照本机 API，实现前打勾：

- [ ] `name` + `apply`，无 default function
- [ ] `inject = ['tools', 'attachments', 'jobs']`（`string[]`）
- [ ] Schemastery `Config`
- [ ] `dsh.bundle.patch` + 预构建 `index.js`
- [ ] 可选参数不写 `required: false`
- [ ] 显式 output object 带 `additionalProperties`
- [ ] `render` 纯 text；图片 `saveImage({ data, mediaType, name })`
- [ ] 规范值用 `attachmentId`，不用 `id`
- [ ] 前台尊重 `exec.signal`；`timeoutMs` 有声明就传到 HTTP
- [ ] 整页 `jobs.start({ kind, label, owner, run: () => JobHooks })`
- [ ] `declare module '@deepseek-ai/dsh-jobs'` 扩展 `mxpage_page`
- [ ] 密钥只读 env；日志脱敏
- [ ] path normalize，拒绝 `..`
- [ ] 工具名只有 `mxpage_*`

---

## 9. 官方链接

- 文档站：https://deepseek-harness.github.io/deepseek-harness/
- 第一个插件：https://deepseek-harness.github.io/deepseek-harness/develop/basic/
- 开发工具：https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool
- 工具权威：https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool
- 配置：https://deepseek-harness.github.io/deepseek-harness/develop/basic/config
- 打包：https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish
- 三角色：https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/
- MxPage：https://github.com/ziguishian/MxPage
- DSH：https://github.com/deepseek-ai/deepseek-harness
