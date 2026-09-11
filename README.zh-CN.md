# dsh-mxpage

[English](./README.md) | 简体中文

把 [MxPage](https://github.com/ziguishian/MxPage) 的电商生图流水线做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **原生插件**，装进官方 **`web` profile**：

**登记商品图 → 分析卖点 → 规划头图/详情 → Visual Prompt Agent → 分镜生图**

这**不是**通用图库。社区插件如 `dsh-imagegen` / `image-generate` / `image_generate` 注册一次性 `generate_image`（或类似）工具。**本插件不注册。** 工具名全部 `mxpage_*`。模型必须走 **分析 → 规划 → VPA → 分镜生成**，把一张商品图做成叙事完整的详情页套图，而不是互不相关的散图。

已对照 **`@deepseek-ai/dsh@0.1.5-rc.1`** 验证。必须装进官方 **`web`** profile，不要用 `sdk-minimal`。

**不是 DeepSeek 官方产品**，与 DeepSeek AI 无隶属关系。MxPage 提示词/schema 仍为 MIT（灵矩绘境），见 [NOTICE](./NOTICE)。

## 付费图像 API — 先读

生图与修图会调用 **OpenAI 兼容 Images API**（`/v1/images/generations`、`/v1/images/edits`）。这是**付费接口**。每次 `mxpage_generate_section`、`mxpage_generate_page`、`mxpage_edit_section` 都会消耗配额。电商 Skill 会提醒模型在整页 job 前先告知用户。

密钥只走环境变量：

```sh
export MXPAGE_IMAGE_API_KEY=sk-...   # 示例 — 在本机填自己的 key，不要把真实密钥贴进对话或仓库
```

**禁止**把密钥写进对话、git、`cordis.patch.yml`、工具参数、浏览器存储或会话事件。插件只读 `process.env[config.imageApiKeyEnv]`（默认环境变量**名**：`MXPAGE_IMAGE_API_KEY`）。日志和工具输出会脱敏 `sk-` / `Bearer`。

## 安装

必须指定 **`web`** profile：

```sh
dsh plugin --profile web add <path-or-spec>
```

示例：

```sh
# GitHub spec
dsh plugin --profile web add github:kim1232aa/dsh-mxpage

# 本地路径（本工位）
dsh plugin --profile web add /workspace/dsh-plugins/dsh-mxpage

# 构建好的 tarball
dsh plugin --profile web add ./dsh-mxpage-0.1.0.tgz
```

然后设置 `MXPAGE_IMAGE_API_KEY`（见上）。重启 `web` profile 让新层生效。

`plugin add` 之后，`dsh --profile web --dump-config` 必须**同时**出现三层：`dsh-mxpage`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-base`。不要把 profile 改成 `sdk-minimal`。

### Skill 目录（文件系统）

官方 web 的 Skill 目录扫描的是 **`$DSH_HOME/skills`**，不是包内的 `skills/`。`plugin add` 之后把随包 Skill 拷过去，目录才能看见它们（这不是改 DSH 源码）：

```sh
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills"
cp -R skills/mxpage-ecommerce-page \
      skills/mxpage-xiaohongshu \
      skills/mxpage-batch-sku \
      "${DSH_HOME:-$HOME/.dsh}/skills/"
```

## 对话示例

附上一张商品图（或给出工作区路径），说：

> 根据这张商品图出一套淘宝详情页

期望：Agent 走 create → analyze → plan → generate，产出 **≥1 张头图 + ≥3 张详情**，同时出现在会话附件和工作区 `$DSH_HOME/mxpage/projects/<id>/`。

## 工具（仅 `mxpage_*`）

没有 `generate_image` / `image_generate` / `image-generate`。

| 工具 | 作用 |
|------|------|
| `mxpage_create_project` | 创建项目，把 1–10 张商品图**复制**（不移动）进 `assets/` |
| `mxpage_add_asset` | 追加图片；替换主图必须显式 `role=main` |
| `mxpage_project_status` | 只读状态机 / section / job |
| `mxpage_analyze_product` | 视觉分析 → `analysis.json` |
| `mxpage_plan_page` | 头图/详情规划 + 风格指南（未分析则拒绝） |
| `mxpage_refine_prompt` | 单张 Visual Prompt Agent |
| `mxpage_generate_section` | 生成一张；未给 `prompt_override` 时先跑 VPA |
| `mxpage_generate_page` | 编排整页（默认后台 job） |
| `mxpage_edit_section` | `repaint` / `enhance` / `translate`（写新版本，不覆盖旧文件） |
| `mxpage_job_status` | 查询整页 job |
| `mxpage_job_cancel` | 取消进行中的 job；已完成的 section 保留 |
| `mxpage_export_page` | 列出输出路径，或写 `output/export-<iso>.zip` |

强制工序：**创建 → 分析 → 规划 → 生图**。详情图锚定原始主图 + 第一张成功的头图。

## Skill（随包分发）

| Skill | 何时用 |
|-------|--------|
| `mxpage-ecommerce-page` | 淘宝 / 天猫 / 京东 / Shopee 头图 + 详情页 |
| `mxpage-xiaohongshu` | 小红书四步：规划 → 确认 VPA 提示词 → 生图 → 编辑 |
| `mxpage-batch-sku` | 一 SKU 一项目；禁止混参考图 |

## 配置（Host，不进浏览器）

插件导出 Schemastery `Config`。关键默认值：

| 字段 | 默认 |
|------|------|
| `imageBaseUrl` | `https://api.openai.com/v1` |
| `imageApiKeyEnv` | `MXPAGE_IMAGE_API_KEY`（环境变量**名**，不是密钥本身） |
| `imageModel` | `gpt-image-2` |
| `defaultLanguage` | `zh-CN` |
| `defaultHeroCount` | `3` |
| `defaultDetailCount` | `6` |
| `allowSvgFallback` | `false`（**不实现** SVG fallback） |
| `generateAsJob` | `true` |

分析 / 规划 / VPA 优先用 web profile 的 `ctx.llm`（需视觉），否则用可选的 `textBaseUrl` + `textApiKeyEnv` + `textModel`。生图始终走 Images API，不走聊天 adapter。

工作区默认：`$DSH_HOME/mxpage/projects/<projectId>/`。可用 `workspaceDir` 覆盖。

## 非目标

- **不**移植 Next.js App Router / Electron / Prisma。这是 Cordis ESM bundle，不是独立应用。
- **不**注册 `generate_image`（避免和社区图库插件撞名）。
- **不**把 API Key 写进浏览器、对话、git 或工具参数。
- **不**挂 `dsh.client` Studio 面板（一期用官方附件预览）。
- **不**做 SVG fallback。失败返回映射后的错误（`401` / 额度 / 超时 / 取消）。
- **不**改 DSH 源码。Profile 保持 `web`。

## 开发

```sh
npm test
npm run build   # 写出预构建 index.js（已提交；GitHub 安装不需要 prepare）
```

`peerDependencies` 为 `"*"`。Host 的 `web` profile 提供 `@deepseek-ai/cordis`、`dsh-tools`、`dsh-jobs`、`dsh-llm`、`schemastery`。`devDependencies` 的 `file:` 指向本工位 `dsh-runtime`，方便 `npm test`；仅从 GitHub 安装时，只要有 `index.js`，`dsh plugin add` 不依赖这些路径。

不要把 `@deepseek-ai/dsh` 写进应用的 `package.json`。

## 许可

MIT。MxPage 提示词、schema 与流水线逻辑为 MIT（灵矩绘境），见 [NOTICE](./NOTICE) 与 [LICENSE](./LICENSE)。

Topics: `dsh-plugin` · `dsh` · `deepseek-harness`
