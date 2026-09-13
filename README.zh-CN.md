# dsh-mxpage

[English](./README.md) | 简体中文

把 [MxPage](https://github.com/ziguishian/MxPage) 的电商商品图工作台做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **原生插件**，装进官方 **`web`** profile：

**登记商品图 → 分析卖点 → 规划头图/详情 → Visual Prompt Agent → 生成 → 编辑 → 导出**

这**不是**通用图库，也**不是**一层薄薄的提示词包装。社区插件如 `dsh-imagegen` 注册的是一次性 `generate_image`。**本插件不注册。** 工具名全部 `mxpage_*`，模型必须走 **分析 → 规划 → VPA → 分镜生成**，把一张商品图做成叙事完整的详情页套图，而不是互不相关的散图。

已对照 **DSH `0.1.2-rc.1`** host 包验证。必须装进官方 **`web`** profile（不要用 `sdk-minimal`）。

**不是 DeepSeek 官方产品**，与 DeepSeek AI 无隶属关系。MxPage 提示词/schema 仍为 MIT（灵矩绘境），见 [NOTICE](./NOTICE)。

---

## 架构 —— "换芯留壳"

v0.1 手工重写了 MxPage 的流水线，丢掉了让它成为产品的部分。v0.2 反过来：上游**内核被整体移植**，DSH 适配层**尽量薄**，上游 **UI 也在移植范围内**。v0.3 把上游剩余的产品面（分析工作台、批量 SKU、用量监控、导出面板、整页翻译）全部补齐。

```
src/core/     上游 lib/ 的宿主无关移植   （永不 import @deepseek-ai/*）
   └── ports/   Repository · ProviderResolver · Logger · StorageDriver · TaskRunner
src/host/     五个端口实现（JSON 仓库、fs 存储、渠道、jobs 任务运行器）
src/shared/   host 与浏览器共享的路由路径
src/tools/    core 服务之上的薄 mxpage_* 包装
src/client/   浏览器面板
```

`src/core/**` 不允许 import `@deepseek-ai/*`、`schemastery`、Next.js、Prisma 或 React，也不允许碰 `process.cwd()` / `process.env` —— 由测试强制保证。

长任务走 **`ctx.jobs`**（`@deepseek-ai/dsh-jobs-local`），由 shell 掌管 job 身份、会话作用域、生命周期状态、完成通知和 owner 销毁取消。`src/host/task-runner.ts` 是没有 registry 的宿主上的兜底 —— 插件两种情况下都能启动，因为 `jobs` 是通过可选的 `ctx.get('jobs')` 访问器读取的。

为什么抽取这么便宜，有据可查：

| 事实 | 证据 |
|---|---|
| 上游 `lib/` 内零 `next/*` import | 唯一例外 `provider-runtime.ts` 引入 `NextRequest` 只为读两个 header |
| `@prisma/client` 出现 9 次 | 两次纯类型；四次只用 `Prisma` 命名空间 |
| 1344 行的 OpenAI adapter 只有**一处**硬耦合 | `import { inferCategory, logApiUsage } from "@/lib/monitor/api-usage"` |

完整接缝清单见 [`src/core/README.md`](src/core/README.md)。

---

## 配置 —— 渠道列表，不是环境变量

v0.1 要求 `MXPAGE_IMAGE_API_KEY`。v0.2 起改用**渠道列表**，可以配置多个端点并轮换：

**设置 → 插件 → MxPage → 渠道**，或在 `cordis.patch.yml` 中：

```yaml
- insert:
    - id: mxpage
      name: dsh-mxpage
      config:
        channels:
          - id: xai
            label: xAI (Grok)
            baseUrl: https://api.example.com/v1
            apiKeyEnv: MXPAGE_XAI_KEY   # 推荐：让密钥不进文档
            models: [grok-imagine-image-2.0]
            textModel: grok-4
            imageModel: grok-imagine-image-2.0
        rotateChannelOnQuotaExhausted: true
```

| 字段 | 含义 |
|---|---|
| `id` / `label` | 轮换键与显示名 |
| `baseUrl` | OpenAI 兼容 base URL；缺 `/v1` 会自动重试 |
| `apiKey` / `apiKeyEnv` | 明文密钥，或（推荐）环境变量**名** |
| `models` | 显式图像模型 id；留空则通过 `GET /models` 发现 |
| `textModel` / `imageModel` | 该渠道上 分析+规划 / 生图 的首选模型 |
| `disabled` | 跳过该渠道而不删除 |

出问题时先跑 **`mxpage_channels`** —— 它会报告当前激活渠道、模型目录、以及是否找到了具备图像能力的模型。

> **模型能力是从模型名推断的。** 上游刻意不做真实端点探测，避免白白烧掉图像配额，所以"名字像图像模型"并不证明网关真能出图。一个宣称有某模型却供不了的网关，会在*失败*时被发现。

---

## 付费图像 API —— 先读

生成与编辑工具调用 **OpenAI 兼容 Images API**（`/images/generations`、`/images/edits`）。这是**付费接口**。每次 `mxpage_generate_section`、`mxpage_generate_page`、`mxpage_edit_section` 都消耗配额。随包 Skill 会提醒模型在整页 job 前先与你确认。

密钥从不出现在工具输出、日志或会话事件中 —— `sk-` 和 `Bearer` 令牌会被脱敏（`src/util/redact.ts`）。

---

## 安装

```sh
# 从本地检出
dsh plugin add link:/absolute/path/to/mxpage

# 或从构建好的 tarball
dsh plugin add ./dsh-mxpage-0.3.0.tgz
```

`dsh plugin add` 会把 bundle 登记进 profile 的 `dsh.profile.bundles`。然后配置一个渠道（见上），重启 profile 让新层生效。

### Skill 目录

Skill 随包分发。把它们拷到 DSH 目录旁，才能被发现：

```sh
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills"
cp -R skills/mxpage-ecommerce-page skills/mxpage-xiaohongshu skills/mxpage-batch-sku \
      "${DSH_HOME:-$HOME/.dsh}/skills/"
```

---

## 对话示例

附上一张商品图，说：

> 根据这张商品图出一套淘宝详情页

期望：Agent 走 create → analyze → plan → generate，产出一套头图加详情分镜，每次都是**新版本**（从不覆盖），存到 `$DSH_HOME/mxpage/projects/<projectId>/` 并作为附件返回。

---

## 面板 —— 八个界面

插件带一个浏览器半包（`lib/client.js`），挂载到 DSH 中栏的工作台，带侧栏开关。这才是上游 MxPage 真正赖以存在的东西：一个有状态的工作区，而不是提示词包装。

| 界面 | 作用 |
|---|---|
| **分析** | 项目元信息（名称 / 平台 / 风格、删除项目）、商品素材网格（上传、排序、设主图、删除）、结构化分析编辑器，一键分析 / 保存分析 |
| **规划** | 输出配置（头图/详情数量、比例、图内语言）、analyze → plan、项目级视觉风格指南、分镜列表（逐镜生成 + 整页 job），以及把整页翻译成目标语言 |
| **编辑** | 逐镜预览，标题/目标/文案/visualPrompt 行内编辑，生成 / 重绘 / 精修 / 翻译，版本列表与激活 |
| **导出** | 一键导出 ZIP / JSON、导出说明、模型快照、当前可导出内容画廊 |
| **小红书** | 四步连环画流程：规划 → 逐页确认 `imagePrompt` → 生图 → 编辑，逐页下载 |
| **批量 SKU** | 每批最多 20 张商品图 —— 一 SKU 一项目，可选后台 analyze+plan，单 SKU 失败互相隔离 |
| **监控** | API 用量账本：调用/Token 总量、Top 模型 / 项目、额度状态分类、逐条删除 / 清空，另有任务历史与失败任务重试 |
| **渠道** | 渠道诊断：激活渠道、模型目录、图像/视觉/文本计数、各渠道密钥在位情况、连接测试与模型发现（含角色推荐）、额度轮换说明 |

重新规划有显式确认保护，因为它会删除项目里所有分镜、版本和已生成图片。

**构建格式说明。** DSH web shell **不**以 ESM 加载客户端半包。它给每个 bundle 一个 `window.__ModuleLoader__.load({ id, factory })` 门面，和一个解析 shell 实时模块表的 `require`。因此 `tsdown` 把浏览器半包产出为 CJS（`lib/client.raw.cjs`），再由 `scripts/wrap-client.mjs` 包进信封。`test/client-bundle.test.ts` 通过模拟门面加载构建产物并断言 `apply` + `inject` 返回 —— 这个测试存在是因为 ESM bundle 会静默地永远不 apply。

面板的数据 API 在 `/api/dsh-mxpage/*`（`src/host/routes.ts`），注册在宿主 `webServer` 上，并限定只接受 loopback 请求。

---

## 工具（仅 `mxpage_*`）

| 工具 | 作用 |
|---|---|
| `mxpage_create_project` | 用对话 `attachment_ids` 和/或 `image_paths` 从 1–10 张图创建项目 |
| `mxpage_add_asset` | 追加图片；`role: "main"` 替换主参考图 |
| `mxpage_project_status` | 只读：分析、分镜、版本、进行中的任务 |
| `mxpage_analyze_product` | 视觉分析 → 类目、材质、卖点、建议规划 |
| `mxpage_plan_page` | 分镜规划 + 项目级 `visualStyleGuide`。**重新规划会删除现有分镜和图片** |
| `mxpage_generate_section` | 生成一镜；未给 `prompt_override` 时先跑 VPA |
| `mxpage_edit_section` | `repaint` / `enhance` / `translate`；写新版本，从不覆盖 |
| `mxpage_generate_page` | 整页后台 job；`mode: "missing"` 只补缺口 |
| `mxpage_job_status` / `mxpage_job_cancel` | job 控制；已完成的分镜保留在磁盘上 |
| `mxpage_export_page` | ZIP（`00-头图/` + `01-详情页/` + `export-manifest.json`）或项目 JSON |
| `mxpage_xiaohongshu_plan` | 小红书第 1 步 —— 有完全本地化的中文兜底规划 |
| `mxpage_xiaohongshu_generate` | 第 3 步 —— 一页一图，VPA 把关 |
| `mxpage_xiaohongshu_edit` | 第 4 步 —— 就地编辑一页 |
| `mxpage_translate_page` | 整页翻译后台 job —— 对每个已生成分镜做一次 `translate` 编辑 |
| `mxpage_update_project` | 重命名项目或修改平台 / 风格 |
| `mxpage_delete_project` | 删除项目及其工作区；必须 `confirm: true` |
| `mxpage_set_main_asset` | 按素材 id 或图片路径替换主参考图 |
| `mxpage_usage_stats` | 用量账本摘要：调用、Token、额度事件、Top 模型 / 项目、近期错误 |
| `mxpage_channels` | 渠道诊断 |

---

## Skill

| Skill | 何时用 |
|---|---|
| `mxpage-ecommerce-page` | 淘宝 / 天猫 / 京东 / Shopee 头图 + 详情页 |
| `mxpage-xiaohongshu` | 四步连环画流程 |
| `mxpage-batch-sku` | 一 SKU 一项目；绝不混用参考图 |

---

## 与上游的差异，及移植中修掉的 bug

**已修复**（每处都在调用点有注释）：

1. **Visual Prompt Agent 重试 bug。** 上游 `requestRaw` 写的是
   `if (urls.length === 1 || options?.suppressUsageLog)`，把"跳过用量记录"和"跳过 base-URL 重试"混为一谈。VPA 是唯一传 `suppressUsageLog: true` 的调用方，于是它悄悄丢了 `/v1`-vs-根路径兜底，在需要带版本号 base URL 的网关上退化成模板提示词。
2. **路径穿越。** 上游 `/api/files/[...path]` 路由把 `rootDir()` 和未校验的相对路径直接 join。存储端口拒绝逃逸（`normalizeRelPath`），该路由整体移除。
3. **跨平台路径。** 上游存的是 `path.join` 的输出（Windows 上是反斜杠），而 URL 构造器用 `split(path.sep)` 转换回来。
4. **生产环境无法取消。** 上游 abort 注册表被 `process.env.NODE_ENV !== "production"` 守卫，生产构建取消不了。
5. **删掉死值：** `ProjectStatus.COMPLETED` 和 `GenerationStatus.QUEUED` 上游没有任何服务会写入。

**刻意保留**（标注出来，不悄悄改）：

- **额度用尽不轮换模型。** 上游 `shouldFallbackToNextImageModel` 对 `429 / quota / 403 / 401` 返回 false，渠道耗尽即中止，而不是试下一个候选。通过 `rotateChannelOnQuotaExhausted` 配置项暴露。
- **`editSectionImage` 不可取消** —— 上游从未在这条路径上注册 abort controller。
- `archiver` 被替换为零依赖 ZIP 写入器，顺带移除了上游的 `process.cwd()` 临时文件。

---

## 开发

```sh
npm install
npm run build     # tsdown → lib/index.js（存在 src/client 时还有 lib/client.js）
npm test          # node --experimental-strip-types --test
npx tsc --noEmit  # 期望 0 错误
```

值得了解的测试：

- `test/bundle.test.ts` —— 包清单健全性，**以及** `src/core/**` 的宿主无关不变量
- `test/core.test.ts` —— ZIP 头/CRC 格式、仓库语义（终态粘性、系统项目隐藏、陈旧恢复）、存储路径围堵、任务取消
- `test/smoke.test.ts` —— 加载**构建产物** `lib/index.js`，对 mock Cordis context 跑真实 `apply()`，断言全部 20 个工具完成注册

---

## 许可

MIT。MxPage 提示词、schema 与流水线逻辑为 MIT（灵矩绘境）—— 见 [NOTICE](./NOTICE) 与 [LICENSE](./LICENSE)。

Topics: `dsh-plugin` · `dsh` · `deepseek-harness` · `mxpage` · `ecommerce`
