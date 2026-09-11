---
name: mxpage-xiaohongshu
description: 小红书图文四步：规划 → Prompt 审核 → 生图 → 编辑。用户提到小红书、种草、笔记配图时使用。
---

# 小红书图文

画幅默认 `3:4`。VPA `mode=xiaohongshu_page`。

## 四步（不要跳）

1. `mxpage_create_project` + `mxpage_analyze_product` + `mxpage_plan_page`（`platform=xiaohongshu`）。
2. 对每个版面 `mxpage_refine_prompt`。把 `finalPrompt` / `negativePrompt` 展示给用户。若部署有 `ask_user_question`，确认后再生图。
3. `mxpage_generate_section` 或 `mxpage_generate_page`。
4. 用户要改图：`mxpage_edit_section`（`repaint` / `enhance`）。

失败（额度、401、无视觉）停止并说明 Config，不要编造图片。
