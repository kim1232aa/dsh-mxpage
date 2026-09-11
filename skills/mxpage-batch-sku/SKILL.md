---
name: mxpage-batch-sku
description: 多 SKU / 批量商品套图。一商品一个 mxpage project，禁止把不同商品的参考图混进同一项目。
---

# 批量 SKU

1. 每个商品：独立 `mxpage_create_project`（自己的主图）。
2. 串行，或最多 `maxParallelProjects`（默认 1）。
3. 不要跨 project 复用 hero 当参考。
4. 全部完成后可分别 `mxpage_export_page`。
5. 整页用 `mxpage_generate_page` 后台 job；用 `mxpage_job_status` 轮询。取消只影响该 job。

提醒用户：每个 SKU 都会消耗图像 API 配额。
