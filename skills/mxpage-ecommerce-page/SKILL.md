---
name: mxpage-ecommerce-page
description: 电商头图、详情页生产。用户提到电商头图、详情页、淘宝/天猫/京东/Shopee 详情、主图、卖点图、整页套图时使用。走 mxpage_* 工具，不要用通用生图工具。
---

# 电商详情页

## 何时用

用户要：商品详情页、头图、卖点图、场景图、规格图，或「根据这张商品图出一套淘宝详情页」。

不要用 `generate_image` / `image_generate` / bash+curl。只用 `mxpage_*`。提示词由工具内部处理（分析 → 规划 → Visual Prompt Agent），不要把提示词全文贴进对话。

## 强制工序

不要跳步。顺序必须是 create → analyze → plan → 生图：

1. **`mxpage_create_project`**。用户在对话里贴的商品图走 `attachment_ids`；工作区文件走 `image_paths`；两者可混用，共 1–10 张，复制不移动。第一张自动成为主图。
   对话里**新的**商品图一律新建项目，不要复用上一个 SKU 的 `project_id`。已有同一 SKU 才用 `mxpage_add_asset`（`role: "main"` 可换主图）。
2. **`mxpage_analyze_product`**。需要视觉模型。失败（无视觉 / 401 / 429 / 额度）则停止，让用户检查渠道配置。**禁止用文件名或路径猜商品**——分析只依据图像本身。
3. **`mxpage_plan_page`**。未分析禁止规划。产出项目级 `visualStyleGuide`（10 字段色彩/光位/字体契约）与 hero + detail 分区。
   ⚠️ **重规划会删除该项目全部 section、版本与已生成的图**，动手前先跟用户确认。
4. **生图**。整页套图用 `mxpage_generate_page`（后台 job，立即返回 jobId）；只要单张主图就传 `section_ids` 限定范围。
   每个分区单独控制用 `mxpage_generate_section`（可选 `prompt_override` 跳过 Visual Prompt Agent）。
   ⚠️ **每次生成都消耗付费图像额度。整页之前先跟用户确认。**
5. **核对与导出**。`mxpage_project_status` 看全貌；`mxpage_export_page` 出 ZIP（`00-头图/` + `01-详情页/` + `export-manifest.json`）或项目 JSON。

## 主图锚定

detail 的参考必须同时包含：**原始主图 + 第一张成功的 hero**。不要把别的 SKU 的图混进来。工具默认就是这么做的，只有显式传 `reference_asset_ids` 才会覆盖。

## 版本与改图

每张生成都是**新版本，从不覆盖旧文件**。改图用 `mxpage_edit_section`：

- `repaint` —— 换构图与氛围，保留商品身份
- `enhance` —— 保留取景，提升真实感/质感/清晰度
- `translate` —— 把图内所有可见文字换成 `target_language`，版面与商品不动

## 后台 job

`mxpage_generate_page` 返回 `jobId` 后：

- 不要循环 `mxpage_job_status` 空转；任务完成会通知你
- 失败或要中止才查 `mxpage_job_status` / 调 `mxpage_job_cancel`（已完成的分区保留在磁盘上）
- 收到 job 完成通知时**不要**新建项目、不要重跑一遍 generate_page

## 失败与禁止

- `MXPAGE_HTTP_401` / 额度不足 / `MXPAGE_NO_VISION`：停止，让用户检查 **渠道配置**（设置 → 插件 → MxPage → 渠道：baseUrl + 密钥 + 模型）。先用 `mxpage_channels` 诊断。
- 模型能力是按**名字**推断的（上游为避免消耗图像额度跳过了真实端点探测），所以「名字像图像模型」不等于网关真支持生图。生成失败先跑 `mxpage_channels` 看它有没有识别出图像模型。
- 不要编造图片，不要从文件名猜测商品，不要用 bash 改图，不要自己 curl 生图，不要把 base64 贴进回复。

## 输出

只用工具返回的 `outputPath` / `attachmentId`。
