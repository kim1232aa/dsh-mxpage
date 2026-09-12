---
name: mxpage-batch-sku
description: 多 SKU / 批量商品套图。一商品一个 mxpage project，禁止把不同商品的参考图混进同一项目。用户提到批量、多 SKU、一堆商品图、批量出详情页时使用。
---

# 批量 SKU

## 铁律

**每个商品一个独立 `mxpage_create_project`**，用该商品自己的主图。

不要跨 project 复用 hero 当参考——hero 是**那个商品**的身份锚点，混用会让 B 商品长出 A 商品的样子。

## 流程

1. 逐个商品：`mxpage_create_project`（`attachment_ids` 或 `image_paths`，该商品自己的图，第一张即主图）。
2. `mxpage_analyze_product` → `mxpage_plan_page`（每个项目各走一遍，不要共用分析结果）。
3. 串行执行，或最多 `maxParallelProjects`（默认 1）。
4. `mxpage_generate_page` 起后台 job，拿 `jobId`。**不要空转轮询** `mxpage_job_status`；完成会通知你。要中止用 `mxpage_job_cancel`，已完成的分区保留。
5. 全部完成后各项目分别 `mxpage_export_page`。

## 提醒用户

- 每个 SKU 都会消耗图像配额，**批量前必须确认数量**。
- 中途失败的 SKU 可以单独重跑 `mxpage_generate_page`（默认 `mode: "missing"` 只补缺图，不会重做已完成的）。
