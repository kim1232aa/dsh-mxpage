# dsh-mxpage 电商生图插件 — 设计规格

日期：2026-09-12  
分类：Architectural  
状态：需求已确认，待按计划实现  
需求源：[docs/requirements.md](../../requirements.md)  
详细指南：[docs/guides/dsh-mxpage-plugin-dev.md](../../guides/dsh-mxpage-plugin-dev.md)

## 目标

把 [MxPage](https://github.com/ziguishian/MxPage) 的 **分析 → 规划 → Visual Prompt Agent → 分镜生成** 流水线做成 DeepSeek Harness 原生插件 `dsh-mxpage`，装进已落地的官方 `web` profile。

用户在 DSH 对话里说「根据这张商品图出一套淘宝详情页」，Agent 能走完整工序，图片出现在会话附件和工作区文件里。

## 非目标

- 不移植 Next.js App Router / Electron / Prisma。
- 不改 DSH 源码，不写新的 LLM Adapter。
- 不注册通用 `generate_image`（避免和社区生图插件抢工具名）。
- 一期不挂 `dsh.client` Studio 面板；用官方附件预览展示生成图。
- SVG fallback 默认关闭（`allowSvgFallback: false`）。
- 不把密钥写进浏览器、会话事件或仓库文件。

## 三种路径

| 路径 | 做法 | 结论 |
|------|------|------|
| A. 只做 Skill，bash + curl 调外部 API | 零插件代码 | 否。无状态、无附件、取消/重试差 |
| B. Host 工具 + Skill + 工作区 | Cordis 插件注册工序工具 | **采用** |
| C. 再加 `dsh.client` Studio | 体验接近原 MxPage | 二期。一期不做 |

## 形态

**单 bundle：`dsh-mxpage`**，函数导出 `name` + `apply`，禁止 `export default function`。

```
用户自然语言
    → Skill: mxpage-ecommerce-page
    → Tools (ctx.tools.register)
         ├─ mxpage service（项目/模块/版本状态机）
         ├─ OpenAI-compatible Images client（/images/generations、/images/edits）
         ├─ ctx.llm 或独立视觉文本端点（分析/规划/VPA）
         ├─ ctx.jobs（整页/批量）
         └─ ctx.attachments + workspace 文件
```

`inject` 必须是字符串数组：`['tools', 'attachments', 'jobs']`。

## 完整 vs 不完整

**不完整（必须判 FAIL）：**

- 没有 `package.json` 的 `dsh.bundle.patch`
- dump-config 里看不到 `# == dsh-mxpage`
- 工具名是 `generate_image` 而不是 `mxpage_*`
- `render` 返回 image block / 原始 base64
- 未分析就允许 `plan_page`（状态机被绕过）
- 密钥出现在日志或工具输出

**完整（P3 验收必须同时满足）：**

1. `dsh plugin --profile web add ./dsh-plugins/dsh-mxpage` 成功。
2. `--dump-config` 出现 mxpage 层。
3. 一张主图 + 自然语言，产出 ≥1 头图 + ≥3 详情图，写入工作区。
4. 主图锚定：detail 的参考图实际传给 Images API（测试用 mock 断言 multipart 含 image）。
5. 面向模型的 render 只有 text；图片经 `saveImage`。

## 工具全集

命名：`mxpage_` + 动词_宾语，小写+下划线。

| 工具 | 作用 | 阶段 |
|------|------|------|
| `mxpage_create_project` | 创建项目并登记商品图（最多 10 张，复制不移动） | P1 |
| `mxpage_add_asset` | 追加图；替换主图必须显式 `role=main` | P1 |
| `mxpage_project_status` | 只读状态机 / section / job | P1 |
| `mxpage_generate_section` | 单张生图；未给 `prompt_override` 时先跑 VPA | P1（P1 可用手工 prompt） |
| `mxpage_analyze_product` | 视觉分析 → `analysis.json` | P2 |
| `mxpage_plan_page` | 头图/详情规划 + style guide | P2 |
| `mxpage_refine_prompt` | Visual Prompt Agent | P2 |
| `mxpage_generate_page` | 编排整页，默认 background job | P3 |
| `mxpage_edit_section` | `repaint` / `enhance` / `translate` | P3 |
| `mxpage_job_status` / `mxpage_job_cancel` | 查询/取消 | P3 |
| `mxpage_export_page` | 路径清单或 zip | P4 |

参数契约、输出 JSON、错误码见 [工具契约](../../guides/mxpage-tool-contracts.md)。实现时不得改工具名。

规划模块类型（闭集）：

`hero | selling_points | scenario | detail_closeup | specs | material | comparison | gift_scene | brand_trust | summary | custom`

画幅：头图默认 `1:1`（1024×1024），详情默认 `3:4` 或 `9:16`（1024×1536）。  
内容语言：`zh-CN` / `en` / `ja` / `ko`。

## 工作区布局

默认根：`$DSH_HOME/mxpage/projects/<projectId>/`  
Config `workspaceDir` 可改为当前 workspace 下 `.mxpage/`。

```
<projectId>/
  project.json
  analysis.json
  plan.json
  style-guide.json
  assets/          # 复制来的商品图
  prompts/
  output/
  versions/<sectionKey>/
  tasks/
```

状态机（非法跳转必须拒绝）：

```
created → analyzing → analyzed → planning → planned
       → generating → generated
       → editing → generated
       → failed
```

所有写盘做 path normalize，拒绝 `..`，禁止写出项目根外。

## 文本模型 vs 图像模型

| 步骤 | 通道 |
|------|------|
| 分析 / 规划 / VPA | 优先 `ctx.llm`（需 `input: [text, image]`）；否则 Config `textBaseUrl` + `textModel` |
| 生图 / 修图 | Config `imageBaseUrl` + `imageModel`，走 `/v1/images/generations` 与 `/v1/images/edits` |

两者不要混在一个 adapter 里。官方 LLM adapter 是聊天补全，不是 Images API。

两者都不可用时，工具返回明确错误，禁止静默用纯文本「猜」商品。

## Skill（随包分发）

| 目录 | 触发 |
|------|------|
| `skills/mxpage-ecommerce-page` | 电商头图、详情页、淘宝/天猫/京东/Shopee |
| `skills/mxpage-xiaohongshu` | 小红书四步：规划 → Prompt 审核 → 生图 → 编辑 |
| `skills/mxpage-batch-sku` | 多 SKU，一商品一 project，禁止混参考图 |

Skill 只描述策略与工具顺序，不复制 `src/prompts/` 全文。

强制工序：create/登记 → analyze → plan →（逐张 refine + generate）或 `generate_page`。

## 配置

Schemastery schema，同时导出 `interface Config` 与 `const Config`。密钥只从环境变量读，默认 `MXPAGE_IMAGE_API_KEY`。字段与默认值见开发指南第 7 节。

日志与工具输出必须脱敏（`sk-`、Bearer）。

## 包布局

代码放在 `dsh-plugins/dsh-mxpage/`（本仓库中文工位）。可分发最小文件：

```
package.json          # dsh.bundle.patch 必须存在
cordis.patch.yml      # 按包名引用
index.js              # tsdown 预构建产物
skills/
NOTICE                # MxPage prompts/schemas 出处（上游 MIT）
```

peerDependencies：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`。已验证 DSH 版本写进 README：`0.1.5-rc.1`（web-app 解析为 `0.1.5-rc.2` 亦可）。

## 已核实的 Host API（以本机 d.ts 为准）

细节与出处见 [规范调查](../../guides/dsh-plugin-spec-investigation.md)。实现不得用口说字段名。

**Jobs。** `ctx.jobs.start` 的 `run()` **同步**返回 `{ cancel, done, readOutput? }`，不是 `async run()`。`JobKindMap` 默认只有 `bash` | `subagent`，必须：

```ts
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { mxpage_page: 'mxpage_page' }
}
```

`exec.signal.aborted` 时禁止 start。发布后改用 job 自有 `AbortController`。规范值 `{ kind: 'background', jobId }`。抄 `dsh-tool-bash`。

**Attachments。** `saveImage({ data: Uint8Array, mediaType, name? })`。引用字段是 `attachmentId`，不是 `id`。`mediaType` 仅 `image/png|jpeg|webp|gif`。

**output.schema。** 显式 object 必须带 `additionalProperties: true | false`。

**社区撞名。** 不要注册 `generate_image`、`image_generate`、`image-generate`。

**VPA schema（MxPage Zod）。** `analysisSummary`, `finalPrompt`（min 20）, `negativePrompt`, `qualityChecklist[]`。

完整参数表：[工具契约](../../guides/mxpage-tool-contracts.md)。Skill 正文：[skill-drafts](../../guides/skill-drafts/)。

## 硬约束


实现阶段逐条核对（完整清单见开发指南第 14 节与 [dsh-plugins/AGENTS.md](../../../dsh-plugins/AGENTS.md)）：

- 导出 `name` + `apply`，不是 default function
- `Config` 是 Schemastery schema
- `inject` 是字符串数组
- 可选参数不写 `required: false`
- `execute` 尊重 AbortSignal；job 启动后改用 job 自带信号
- 面向模型的 render 只有 text
- 图片先 `saveImage`
- 密钥只来自环境变量

## 分期

| 阶段 | 可演示结果 |
|------|------------|
| P0 | 空包能 `plugin add`，dump-config 可见 |
| P1 | 一句话出一张电商主图（手工 prompt + Images API） |
| P2 | 分析 / 规划 / VPA + ecommerce Skill |
| P3 | 整页 job + 编辑/翻译 + 主图锚定 |
| P4 | 小红书 Skill、批量 SKU、导出 zip |
| P5 | 脱敏、配额文案、README、tgz |

P3 达到原始需求的对话验收（一套详情页）。P4/P5 覆盖「小红书 / 批量 / 可发布」。

## 风险

- DSH 仍是 developer preview，锁定已验证版本。
- 图像 API 计费：Skill 在 `generate_page` 前应提醒配额。
- 图上文字不稳定：不承诺 100% 可上架文字。
- 上游 MxPage MIT，保留 `NOTICE` 署名；不要宣称 DeepSeek 官方产品。
