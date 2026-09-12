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

1. `mxpage_create_project`。对话里**新的**商品图一律新建项目（`attachment_ids`），不要复用上一个 SKU 的 `project_id`。工作区文件用 `image_paths`。主图必须明确；默认第一张。最多 10 张，复制不移动。已有同一 SKU 才 `mxpage_add_asset`。
2. `mxpage_analyze_product`。需要视觉。失败（无视觉 / 401 / 429 / 额度）则停止，告诉用户改 Config 或环境变量 `MXPAGE_IMAGE_API_KEY` / 文本视觉端点。禁止用文件名猜商品。
3. `mxpage_plan_page`。未分析禁止规划。
4. 用户只要**一张主图/头图**（「淘宝主图」「帮我生成一张」）：`mxpage_create_project` 的 name 用「淘宝主图」，然后 `mxpage_generate_page` **必须**带 `section_keys: ["hero_01"]`。禁止规划/生成 3 张详情。不要用「淘宝详情页」这个名字。
   用户要整页套图（「一套详情页」「详情页」）才不传 `section_keys`，此时 name 才用「淘宝详情页」。`mxpage_generate_page` 会消耗图像配额，并等后台 job 结束带出图片附件；不要循环 `mxpage_job_status`。单张主图也可以 `mxpage_refine_prompt` → `mxpage_generate_section`（`section_key: hero_01`）。失败才看 `mxpage_job_status` / `mxpage_job_cancel`。
5. 生成完成后可用 `mxpage_project_status` 核对。取消用 `mxpage_job_cancel`，已完成的 section 保留。不要循环调用 `mxpage_job_status`。收到 tool-jobs 完成通知时不要新建项目、不要再跑一遍 generate_page。

## 主图锚定

detail 的参考必须同时包含：原始主图 + 第一张成功的 hero。不要把别的 SKU 的图混进来。

## 失败与禁止

- 401、额度不足、无视觉：停止，指导用户修 Config / `MXPAGE_IMAGE_API_KEY`。不要编造图片，不要从文件名猜测商品。
- 不要用 bash 改图、不要自己 curl 生图、不要把 base64 贴进回复。

## 输出

只用工具返回的 `outputPath` / `attachmentId`。
