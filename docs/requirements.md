# 原始需求

日期：2026-09-12  
状态：规范已调查；环境已落地；插件 P0–P5 已实现；官方 web 对话验收已通过（1 头图 + 3 详情）

## 用户原话（需求真源）

> 把 https://github.com/ziguishian/MxPage 做成 dsh（https://github.com/deepseek-ai/deepseek-harness）的电商生图插件，**先调查插件规范，写开发文档**。

后补约束（已执行）：预览必须是 **官方完整 `web` profile**，禁止 `sdk-minimal` / `headless` / 手戳聊天页。

不要把后补的环境工作写成「最初要求」的全部。最初要求是 **调查规范 + 写 MxPage→DSH 电商生图开发文档**。

---

## 一句话

把 MxPage 的 **分析 → 规划 → Visual Prompt Agent → 分镜生成** 做成可安装的 DSH 原生插件 `dsh-mxpage`，跑在官方完整 `web` profile 上。

## 必须做到

1. **先规范、后代码。** 对照官方文档 + 本机 `0.1.5-rc.1` d.ts 写清插件形态、工具、jobs、附件、Skill、打包。见 [规范调查](./guides/dsh-plugin-spec-investigation.md)。
2. **MxPage 做成插件，不是再做一个 Web 应用。** 不移植 Next.js / Electron / Prisma。
3. **电商工序工具，不是通用生图。** 工具名 `mxpage_*`，不注册 `generate_image` / `image_generate`。
4. **对话验收。** 「根据这张商品图出一套淘宝详情页」→ 分析/规划/VPA/分镜，≥1 头图 + ≥3 详情，附件 + 工作区文件。
5. **单图、整页、编辑、翻译、小红书四步、批量 SKU** 都能被工具组合覆盖。
6. **可独立发布：** `dsh plugin --profile web add dsh-mxpage`，无需改 DSH 源码。
7. **官方完整 web**（环境前提，已落地）：不是精简/手戳；完整性可自动判定。

## 明确不做

| 不做 | 原因 |
|------|------|
| 移植 Next.js / Electron / Prisma | Cordis ESM 插件，不是独立应用 |
| 再做一个通用画布/图库 | 社区已有生图插件 |
| 改 DSH 源码、写新 LLM Adapter | 文本走 `ctx.llm` 或独立端点；图走 Images API |
| API Key 进浏览器/会话/仓库 | 只读环境变量 |
| `render` 里塞 image block / base64 | 先 `saveImage({ data, mediaType })` |
| `@deepseek-ai/dsh` 进根 `package.json` | runtime 在 `dsh-runtime/` |
| 把 `XAI_API_KEY` 当成 DeepSeek key | 两套密钥 |

## 成功标准

1. 规范调查与开发文档齐全，API 与本机 d.ts 一致（jobs 是 `run(): JobHooks`，附件字段是 `data` / `attachmentId`）。
2. 预览是官方 DeepSeek Harness GUI。
3. 一张主图 + 一句话 → ≥1 头图 + ≥3 详情，主体锚定。
4. 失败可读（额度/端点/模型/取消），无堆栈、无密钥。
5. 文本-only 路由不因未声明 image block 拒绝对话。
6. `dsh plugin add` 后无需改 DSH 源码。

## 分阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| 0. 规范调查 + 开发文档 | 官方插件规范、MxPage 流水线、工具契约、Skill 草稿 | **本文档集** |
| 1. 环境 | 官方完整 `web` + 预览代理 + 完整性门禁 | **已落地** |
| 2. 插件实现 | `dsh-mxpage` P0–P5 | **已落地；官方对话验收 1 头图 + 3 详情** |

## 文档去哪读

| 先读 | 文件 |
|------|------|
| 规范调查（最初要求的第一步） | [guides/dsh-plugin-spec-investigation.md](./guides/dsh-plugin-spec-investigation.md) |
| 工具契约全文 | [guides/mxpage-tool-contracts.md](./guides/mxpage-tool-contracts.md) |
| Skill 草稿 | [guides/skill-drafts/](./guides/skill-drafts/) |
| 插件规格 | [superpowers/specs/2026-09-12-dsh-mxpage-plugin-design.md](./superpowers/specs/2026-09-12-dsh-mxpage-plugin-design.md) |
| 实现计划 | [superpowers/plans/2026-09-12-dsh-mxpage-plugin.md](./superpowers/plans/2026-09-12-dsh-mxpage-plugin.md) |
| 开发指南（调查细节） | [guides/dsh-mxpage-plugin-dev.md](./guides/dsh-mxpage-plugin-dev.md) |
