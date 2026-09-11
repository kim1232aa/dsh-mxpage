---
name: mxpage-ecommerce-page
description: 电商头图与详情页生产。用户提到淘宝/天猫/京东/Shopee 详情、主图、卖点图、整页套图时使用。走 mxpage_* 工具，不要用通用生图工具。
---

# 电商详情页

## 何时用

用户要：商品详情页、头图、卖点图、场景图、规格图，或「根据这张商品图出一套淘宝详情页」。

不要用 `generate_image` / `image_generate` / bash+curl。只用 `mxpage_*`。

## 强制工序

1. `mxpage_create_project`（或已有 `project_id` 则 `mxpage_add_asset`）。主图必须明确；默认第一张。最多 10 张，复制不移动。
2. `mxpage_analyze_product`。需要视觉。失败（无视觉 / 401 / 429）则停止，告诉用户改 Config 或 `MXPAGE_IMAGE_API_KEY` / 文本视觉端点。禁止用文件名猜商品。
3. `mxpage_plan_page`。未分析禁止规划。
4. 整页：`mxpage_generate_page`（后台 job，先提醒会消耗图像配额）。单张：`mxpage_refine_prompt` → `mxpage_generate_section`。
5. 进度用 `mxpage_job_status` / `mxpage_project_status`。取消用 `mxpage_job_cancel`；已完成的 section 保留。

## 主图锚定

detail 的参考必须同时包含：原始主图 + 第一张成功的 hero。不要把别的 SKU 的图混进来。

## 输出

只用工具返回的 `outputPath` / `attachmentId`。不要自己用 bash 改图、不要把 base64 贴进回复。
