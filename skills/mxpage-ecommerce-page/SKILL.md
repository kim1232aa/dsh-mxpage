---
name: mxpage-ecommerce-page
description: 电商头图、详情页生产。用户提到电商头图、详情页、淘宝/天猫/京东/Shopee 详情、主图、卖点图、整页套图时使用。走 mxpage_* 工具，不要用通用生图工具。
---

# 电商详情页

## 何时用

用户要：商品详情页、头图、卖点图、场景图、规格图，或「根据这张商品图出一套淘宝详情页」。

不要用 `generate_image` / `image_generate` / bash+curl。只用 `mxpage_*`。提示词由工具内部处理，不要把 `src/prompts/` 全文贴进对话。

## 强制工序

不要跳步。顺序必须是 create → analyze → plan → 生图：

1. `mxpage_create_project`（或已有 `project_id` 则 `mxpage_add_asset`）。主图必须明确；默认第一张。最多 10 张，复制不移动。
2. `mxpage_analyze_product`。需要视觉。失败（无视觉 / 401 / 429 / 额度）则停止，告诉用户改 Config 或环境变量 `MXPAGE_IMAGE_API_KEY` / 文本视觉端点。禁止用文件名猜商品。
3. `mxpage_plan_page`。未分析禁止规划。
4. 整页：先提醒 `mxpage_generate_page` 会消耗图像配额，再调用它（后台 job）。若该工具尚未注册或不存在，则对每个 section 走 `mxpage_refine_prompt` → `mxpage_generate_section`。用户只要单张时也走这条 per-section 路径。
5. 进度用 `mxpage_project_status`。若有 `mxpage_job_status` / `mxpage_job_cancel` 则用之；取消时已完成的 section 保留。

## 主图锚定

detail 的参考必须同时包含：原始主图 + 第一张成功的 hero。不要把别的 SKU 的图混进来。

## 失败与禁止

- 401、额度不足、无视觉：停止，指导用户修 Config / `MXPAGE_IMAGE_API_KEY`。不要编造图片，不要从文件名猜测商品。
- 不要用 bash 改图、不要自己 curl 生图、不要把 base64 贴进回复。

## 输出

只用工具返回的 `outputPath` / `attachmentId`。
