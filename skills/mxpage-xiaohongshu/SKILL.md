---
name: mxpage-xiaohongshu
description: 小红书图文四步流。用户提到小红书图文、小红书笔记、种草图、轮播图、九宫格、封面图、图文笔记时使用。走 mxpage_xiaohongshu_* 工具。
---

# 小红书图文四步流

## 何时用

用户要：小红书笔记配图、种草图、轮播图、封面组图，或「围绕这个商品出一篇小红书图文」。

不要用 `generate_image` / `image_generate`。只用 `mxpage_xiaohongshu_*`。

## 四步

顺序固定，每步之间要跟用户确认：

1. **规划** —— `mxpage_xiaohongshu_plan`（`topic` 必填，`image_count` 3–8 默认 5，`aspect_ratio` 默认 **3:4**）。
   产出每页的 `title` / 正文 / `imagePrompt`。模型不可用时会自动回退到**完全本地的中文模板方案**，仍然可用。
2. **审阅** —— 把每页的 `imagePrompt` 给用户过目、按需改写。这一步不调工具，是纯确认。
3. **生成** —— `mxpage_xiaohongshu_generate`，传上一步返回的 `plan`（JSON 编码进 `plan_json`）。
   每页都会先跑 Visual Prompt Agent（`mode: "xiaohongshu_page"`）。**消耗付费图像额度，动手前先确认。**
4. **改图** —— `mxpage_xiaohongshu_edit`，传第 3 步某页的 `imageUrl` 和修改要求（换字、调风格、修细节）。
   图是 data URL 或上游 URL 原样传递；URL 形式可能会过期，尽快用。

## 画幅

默认 **3:4**。其他可选 `1:1` / `9:16`。同一组图保持同一画幅。

## 注意

- 小红书这条链路**不落盘、不建项目**——图只以引用形式返回。要归档请把 `imageUrl` 交给用户，或改用电商链路（`mxpage_create_project` + `mxpage_generate_page`）以获得版本与导出。
- 中文文案由提示词层处理，不要把提示词全文贴进对话。
- 失败（401 / 429 / 额度）先跑 `mxpage_channels` 诊断渠道。
