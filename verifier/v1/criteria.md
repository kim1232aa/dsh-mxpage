# Verifier v1 — MxPage UI/能力无缝集成验收标准

目标：`dsh-mxpage` 插件覆盖上游 https://github.com/ziguishian/MxPage 的全部用户可见能力，
面板 UI 与上游页面对齐。基线：v0.2.0（51/51 tests, build OK）。

## A. 能力对齐（上游有 → 插件必须有等价物）

| # | 上游能力 | 插件落点 | 判定 |
|---|----------|----------|------|
| A1 | translate-page（整页图内文字翻译任务） | 工具 `mxpage_translate_page` + host 路由 + 面板操作；逐分区 translate 编辑、进度可查、可取消 | 路由/工具/UI 存在，e2e mock 走通 |
| A2 | 项目重命名 / 更新 / 删除 | 路由 + 工具 `mxpage_update_project` / `mxpage_delete_project` + UI；删除清理工作区文件 | 单测 + 路由存在 |
| A3 | 素材排序 / 设主图 / 删除 | 路由 + UI；工具 `mxpage_set_main_asset` | 路由存在 + UI 入口 |
| A4 | 供应商 测试连接 / 发现模型 / 能力探测 | 路由 `providers/test`、`providers/discover` + 渠道页按钮 | 路由存在 + UI 入口 |
| A5 | API 用量监控页（汇总/明细/筛选/清空/删单条） | 读 usage.jsonl → 路由 + 监控页签 | 汇总逻辑单测 + UI 页签 |
| A6 | 任务历史 + 失败重试 | 路由 tasks 列表 / retry + 监控页内入口 | 路由存在 |
| A7 | 批量 SKU 建项（多图 → 每 SKU 独立项目） | 路由 batch-create + 批量页签 | 路由存在 + UI 页签 |
| A8 | 小红书第四步 review（预览整套卡片 + 导出） | 小红书页签内 review 阶段 | UI 存在 |
| A9 | 分析工作台（结构化字段可编辑保存、项目属性编辑、素材管理） | 分析页签 | UI 存在 + save 路由 |
| A10 | 导出面板（ZIP/JSON + 模型快照 + 可导出内容预览） | 导出页签 | UI 存在 |

## B. 红线保持（不得回退）

- B1 工具名清一色 `mxpage_*`；不注册 generate_image / edit_image。
- B2 密钥只读环境变量；页面/日志/报错无明文（新代码同样遵守 redactSecrets）。
- B3 `src/core/**` 不 import `@deepseek-ai/*`、Next.js、Prisma、React；不碰 process.cwd/env。
- B4 无空 catch；异常可读。
- B5 面板异常不导致宿主白屏（新页签同样走 ErrorBoundary 惯例）。

## C. 工程验证

- C1 `npm run build`（tsdown + wrap-client）成功，lib/index.js + lib/client.js 更新。
- C2 `node --experimental-strip-types --test test/**/*.test.ts` 全绿（基线 51 + 新增）。
- C3 mock-upstream e2e 走通（现有 e2e.test.ts + 新增 translate/monitor 覆盖）。
- C4 新增核心逻辑（usage 汇总、translate 任务、batch、project delete 清理）有单测。

## D. 交付

- D1 文档同步：tool-contracts、README 能力表、验收标准回写。
- D2 版本号 bump 0.3.0。
- D3 commit + push 到 kim1232aa/dsh-mxpage。
